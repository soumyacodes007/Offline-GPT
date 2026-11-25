import {
  chunkDocument,
  decideKnowledgeRead,
  loadKnowledgeRules,
  resolveMemberAccessContext,
  searchKnowledge,
  type AccessPolicyRule,
} from "@offlinegpt-ee/den-db"
import { and, asc, desc, eq, inArray, isNull } from "@offlinegpt-ee/den-db/drizzle"
import { AccessPolicyRuleTable, KnowledgeChunkTable, KnowledgeDocumentTable, knowledgeSensitivityValues } from "@offlinegpt-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@offlinegpt-ee/utils/typeid"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { extractKnowledgeText, KnowledgeExtractError, knowledgeSourceMimeTypes } from "../../knowledge-extract.js"
import { jsonValidator, orgMemberRoute, paramValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { principalExists } from "./access-policy.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole, ensureOrganizationSuperAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"

const MAX_DOCUMENT_CHARS = 2_000_000
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const principalSchema = z.object({
  principalKind: z.enum(["member", "team", "role", "org"]),
  principalId: z.string().trim().min(1).max(191),
})

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  text: z.string().min(1).max(MAX_DOCUMENT_CHARS).describe("Plain text or Markdown. Headings start new chunks."),
  sourceName: z.string().trim().min(1).max(300).optional(),
  mimeType: z.enum(knowledgeSourceMimeTypes).default("text/markdown").describe("The source file's type; the text itself is always Markdown or plain text."),
  audience: z.array(principalSchema).min(1).max(50).optional().describe("Who can read the document. Defaults to everyone in the organization."),
  sensitivity: z.enum(knowledgeSensitivityValues).default("ordinary").describe("Label for every chunk; change single chunks afterwards."),
}).meta({ ref: "KnowledgeDocumentCreate" })

const labelSchema = z.object({ sensitivity: z.enum(knowledgeSensitivityValues) }).meta({ ref: "KnowledgeChunkLabel" })
const searchSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(8) }).meta({ ref: "KnowledgeSearch" })
const documentParams = idParamSchema("documentId", "knowledgeDocument")
const chunkParams = idParamSchema("chunkId", "knowledgeChunk")
const looseSchema = z.object({}).passthrough()

type OrganizationId = typeof KnowledgeDocumentTable.$inferSelect.organizationId
type DocumentRow = typeof KnowledgeDocumentTable.$inferSelect

function serializeRule(rule: typeof AccessPolicyRuleTable.$inferSelect) {
  return {
    id: rule.id,
    principalKind: rule.principalKind,
    principalId: rule.principalId,
    effect: rule.effect,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    reason: rule.reason,
  }
}

function serializeDocument(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    sourceName: row.sourceName,
    mimeType: row.mimeType,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdAt: row.createdAt.toISOString(),
  }
}

async function liveRules(organizationId: OrganizationId, resourceKind: "knowledge_document" | "knowledge_chunk", resourceIds: string[]) {
  if (resourceIds.length === 0) return []
  return db.select().from(AccessPolicyRuleTable).where(and(
    eq(AccessPolicyRuleTable.organizationId, organizationId),
    eq(AccessPolicyRuleTable.resourceKind, resourceKind),
    inArray(AccessPolicyRuleTable.resourceId, resourceIds),
    isNull(AccessPolicyRuleTable.removedAt),
  ))
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const map = new Map<string, T[]>()
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row])
  return map
}

async function readableChunks(input: { rules: AccessPolicyRule[]; memberId: string; documentId: string; chunks: Array<{ id: string; sensitivity: (typeof knowledgeSensitivityValues)[number] }> }) {
  const context = await resolveMemberAccessContext(db, input.memberId)
  if (!context) return new Set<string>()
  return new Set(input.chunks.filter((chunk) => decideKnowledgeRead({
    rules: input.rules, principals: context.principals, documentId: input.documentId, chunkId: chunk.id, sensitivity: chunk.sensitivity,
  }).allowed).map((chunk) => chunk.id))
}

export function registerOrgKnowledgeRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/knowledge/extract",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Read the text out of a file",
      description: "Upload a PDF, Word (.docx), Markdown or text file as multipart field `file`. Returns its text as Markdown, one section per PDF page or Word heading, for review before it is added. Nothing is stored.",
      responses: {
        200: jsonResponse("Extracted text.", z.object({ title: z.string(), text: z.string(), mimeType: z.enum(knowledgeSourceMimeTypes), sourceName: z.string() })),
        400: jsonResponse("Unreadable file.", invalidRequestSchema),
        403: jsonResponse("Forbidden.", forbiddenSchema),
        413: jsonResponse("Too large.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(),
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: "file_too_large", message: "Upload files under 25 MB." }, 413),
    }),
    async (c) => {
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can add knowledge, because it sets who can read it.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const body = await c.req.parseBody().catch(() => null)
      const file = body?.file instanceof File ? body.file : null
      if (!file) return c.json({ error: "invalid_request", message: "Upload the file as multipart form field \"file\"." }, 400)
      try {
        const { text, mimeType } = await extractKnowledgeText(file.name, new Uint8Array(await file.arrayBuffer()))
        if (text.length > MAX_DOCUMENT_CHARS) return c.json({ error: "document_too_long", message: "This file has more text than one document can hold. Split it into parts." }, 400)
        return c.json({ title: file.name.replace(/\.(pdf|docx|md|markdown|txt)$/i, "").slice(0, 300), text, mimeType, sourceName: file.name.slice(0, 300) })
      } catch (error) {
        if (error instanceof KnowledgeExtractError) return c.json({ error: "unreadable_file", message: error.message }, 400)
        throw error
      }
    },
  )

  app.post(
    "/v1/knowledge/documents",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Add a document to the knowledge base",
      description: "Splits the text into chunks and writes one allow rule per audience principal. Documents are closed by default, so only the audience can read them.",
      responses: {
        201: jsonResponse("Created.", z.object({ document: looseSchema, chunkCount: z.number() })),
        400: jsonResponse("Invalid.", invalidRequestSchema),
        403: jsonResponse("Forbidden.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can add knowledge, because it sets who can read it.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const input = c.req.valid("json")
      const organizationId = payload.organization.id
      const audience = input.audience ?? [{ principalKind: "org" as const, principalId: organizationId }]
      for (const principal of audience) {
        if (!(await principalExists(organizationId, principal.principalKind, principal.principalId))) {
          return c.json({ error: "invalid_principal", message: `No ${principal.principalKind} ${principal.principalId} in this organization.` }, 400)
        }
      }
      const drafts = chunkDocument(input.text)
      if (drafts.length === 0) return c.json({ error: "empty_document", message: "The document has no text." }, 400)
      const now = new Date()
      const document: DocumentRow = {
        id: createDenTypeId("knowledgeDocument"),
        organizationId,
        title: input.title,
        sourceName: input.sourceName ?? null,
        mimeType: input.mimeType,
        createdByOrgMembershipId: payload.currentMember.id,
        createdAt: now,
        removedAt: null,
      }
      await db.transaction(async (tx) => {
        await tx.insert(KnowledgeDocumentTable).values(document)
        await tx.insert(KnowledgeChunkTable).values(drafts.map((draft, ordinal) => ({
          id: createDenTypeId("knowledgeChunk"),
          organizationId,
          documentId: document.id,
          ordinal,
          heading: draft.heading,
          text: draft.text,
          sensitivity: input.sensitivity,
          createdAt: now,
        })))
        await tx.insert(AccessPolicyRuleTable).values(audience.map((principal) => ({
          id: createDenTypeId("accessPolicyRule"),
          organizationId,
          resourceKind: "knowledge_document" as const,
          resourceId: document.id,
          principalKind: principal.principalKind,
          principalId: principal.principalId,
          effect: "allow" as const,
          expiresAt: null,
          reason: `Audience of "${input.title}"`.slice(0, 1000),
          createdByOrgMembershipId: payload.currentMember.id,
          createdAt: now,
          removedAt: null,
          removedByOrgMembershipId: null,
        })))
      })
      await recordOrganizationAuditEvent({
        organizationId,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.knowledgeDocumentCreated,
        payload: { documentId: document.id, title: document.title, chunkCount: drafts.length, sensitivity: input.sensitivity, audience: audience.map((p) => `${p.principalKind}:${p.principalId}`).join(",") },
      })
      return c.json({ document: serializeDocument(document), chunkCount: drafts.length }, 201)
    },
  )

  app.get(
    "/v1/knowledge/documents",
    describeRoute({
      tags: ["Knowledge"],
      summary: "List knowledge documents",
      description: "Admins see every document with its audience and chunk labels; members see the documents they can read and how many chunks they can read.",
      responses: { 200: jsonResponse("Documents.", z.object({ documents: z.array(looseSchema) })) },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const isAdmin = ensureOrganizationAdminRole(c, "").ok
      const documents = await db.select().from(KnowledgeDocumentTable)
        .where(and(eq(KnowledgeDocumentTable.organizationId, organizationId), isNull(KnowledgeDocumentTable.removedAt)))
        .orderBy(desc(KnowledgeDocumentTable.createdAt))
      if (documents.length === 0) return c.json({ documents: [] })
      const ids = documents.map((doc) => doc.id)
      const chunks = await db.select({ id: KnowledgeChunkTable.id, documentId: KnowledgeChunkTable.documentId, sensitivity: KnowledgeChunkTable.sensitivity })
        .from(KnowledgeChunkTable).where(inArray(KnowledgeChunkTable.documentId, ids))
      const chunksByDocument = groupBy(chunks, (chunk) => chunk.documentId)
      if (isAdmin) {
        const audience = groupBy(await liveRules(organizationId, "knowledge_document", ids), (rule) => rule.resourceId)
        const chunkRuleCounts = groupBy(await liveRules(organizationId, "knowledge_chunk", chunks.map((chunk) => chunk.id)), (rule) => rule.resourceId)
        return c.json({
          documents: documents.map((doc) => {
            const docChunks = chunksByDocument.get(doc.id) ?? []
            return {
              ...serializeDocument(doc),
              chunkCount: docChunks.length,
              sensitivity: Object.fromEntries(knowledgeSensitivityValues.map((label) => [label, docChunks.filter((chunk) => chunk.sensitivity === label).length])),
              chunksWithRules: docChunks.filter((chunk) => chunkRuleCounts.has(chunk.id)).length,
              audience: (audience.get(doc.id) ?? []).map(serializeRule),
            }
          }),
        })
      }
      const rules = await loadKnowledgeRules(db, organizationId)
      const visible = []
      for (const doc of documents) {
        const readable = await readableChunks({ rules, memberId: payload.currentMember.id, documentId: doc.id, chunks: chunksByDocument.get(doc.id) ?? [] })
        if (readable.size > 0) visible.push({ ...serializeDocument(doc), chunkCount: readable.size })
      }
      return c.json({ documents: visible })
    },
  )

  app.get(
    "/v1/knowledge/documents/:documentId",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Read a knowledge document",
      description: "Admins get every chunk with its label and chunk rules. Members get only the chunks they can read and a count of the hidden ones.",
      responses: { 200: jsonResponse("Document.", looseSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(),
    paramValidator(documentParams),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const documentId = normalizeDenTypeId("knowledgeDocument", c.req.valid("param").documentId)
      const [doc] = await db.select().from(KnowledgeDocumentTable).where(and(
        eq(KnowledgeDocumentTable.id, documentId), eq(KnowledgeDocumentTable.organizationId, organizationId), isNull(KnowledgeDocumentTable.removedAt),
      )).limit(1)
      if (!doc) return c.json({ error: "knowledge_document_not_found" }, 404)
      const chunks = await db.select().from(KnowledgeChunkTable).where(eq(KnowledgeChunkTable.documentId, documentId)).orderBy(asc(KnowledgeChunkTable.ordinal))
      const serializeChunk = (chunk: typeof KnowledgeChunkTable.$inferSelect) => ({ id: chunk.id, ordinal: chunk.ordinal, heading: chunk.heading, text: chunk.text, sensitivity: chunk.sensitivity })
      if (ensureOrganizationAdminRole(c, "").ok) {
        const audience = await liveRules(organizationId, "knowledge_document", [documentId])
        const chunkRules = groupBy(await liveRules(organizationId, "knowledge_chunk", chunks.map((chunk) => chunk.id)), (rule) => rule.resourceId)
        return c.json({
          document: { ...serializeDocument(doc), audience: audience.map(serializeRule) },
          chunks: chunks.map((chunk) => ({ ...serializeChunk(chunk), rules: (chunkRules.get(chunk.id) ?? []).map(serializeRule) })),
          hiddenCount: 0,
        })
      }
      const rules = await loadKnowledgeRules(db, organizationId)
      const readable = await readableChunks({ rules, memberId: payload.currentMember.id, documentId, chunks })
      if (readable.size === 0) return c.json({ error: "knowledge_document_not_found" }, 404)
      return c.json({
        document: serializeDocument(doc),
        chunks: chunks.filter((chunk) => readable.has(chunk.id)).map(serializeChunk),
        hiddenCount: chunks.length - readable.size,
      })
    },
  )

  app.patch(
    "/v1/knowledge/chunks/:chunkId",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Change a chunk's sensitivity label",
      responses: { 200: jsonResponse("Updated.", looseSchema), 403: jsonResponse("Forbidden.", forbiddenSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(),
    paramValidator(chunkParams),
    jsonValidator(labelSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can relabel knowledge.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const chunkId = normalizeDenTypeId("knowledgeChunk", c.req.valid("param").chunkId)
      const { sensitivity } = c.req.valid("json")
      const [chunk] = await db.select({ id: KnowledgeChunkTable.id, documentId: KnowledgeChunkTable.documentId, sensitivity: KnowledgeChunkTable.sensitivity })
        .from(KnowledgeChunkTable).where(and(eq(KnowledgeChunkTable.id, chunkId), eq(KnowledgeChunkTable.organizationId, payload.organization.id))).limit(1)
      if (!chunk) return c.json({ error: "knowledge_chunk_not_found" }, 404)
      await db.update(KnowledgeChunkTable).set({ sensitivity }).where(eq(KnowledgeChunkTable.id, chunkId))
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.knowledgeChunkLabelled,
        payload: { chunkId, documentId: chunk.documentId, from: chunk.sensitivity, to: sensitivity },
      })
      return c.json({ chunk: { id: chunkId, sensitivity } })
    },
  )

  app.delete(
    "/v1/knowledge/documents/:documentId",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Remove a knowledge document",
      responses: { 204: { description: "Removed." }, 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(),
    paramValidator(documentParams),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can remove knowledge.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const documentId = normalizeDenTypeId("knowledgeDocument", c.req.valid("param").documentId)
      const [doc] = await db.select().from(KnowledgeDocumentTable).where(and(
        eq(KnowledgeDocumentTable.id, documentId), eq(KnowledgeDocumentTable.organizationId, payload.organization.id), isNull(KnowledgeDocumentTable.removedAt),
      )).limit(1)
      if (!doc) return c.json({ error: "knowledge_document_not_found" }, 404)
      // Chunks are deleted, not kept: removing a document must remove its text from search.
      await db.transaction(async (tx) => {
        await tx.update(KnowledgeDocumentTable).set({ removedAt: new Date() }).where(eq(KnowledgeDocumentTable.id, documentId))
        await tx.delete(KnowledgeChunkTable).where(eq(KnowledgeChunkTable.documentId, documentId))
      })
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.knowledgeDocumentRemoved,
        payload: { documentId, title: doc.title },
      })
      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/knowledge/search",
    describeRoute({
      tags: ["Knowledge"],
      summary: "Search the knowledge base as the calling member",
      description: "Returns only chunks the caller can read. Results that include sensitive or restricted chunks are audited.",
      responses: { 200: jsonResponse("Results.", z.object({ results: z.array(looseSchema) })) },
    }),
    orgMemberRoute(),
    jsonValidator(searchSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const context = await resolveMemberAccessContext(db, payload.currentMember.id)
      if (!context) return c.json({ results: [] })
      const results = await searchKnowledge(db, { context, query: input.query, limit: input.limit, surface: "den_api" })
      return c.json({ results })
    },
  )
}
