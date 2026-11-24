import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { createDenTypeId, normalizeDenTypeId } from "@offlinegpt-ee/utils/typeid"
import type { createDenDb } from "./client"
import {
  decideAccess,
  loadAccessPolicyRules,
  type AccessDecision,
  type AccessPolicyRule,
  type AccessPrincipal,
  type MemberAccessContext,
} from "./access-policy"
import { KnowledgeChunkTable, KnowledgeDocumentTable, type knowledgeSensitivityValues } from "./schema/knowledge"
import { AuditEventTable } from "./schema/workers"

type DenDb = ReturnType<typeof createDenDb>["db"]

export type KnowledgeSensitivity = (typeof knowledgeSensitivityValues)[number]

export type KnowledgeChunkDraft = { heading: string | null; text: string }

/**
 * Split a text or Markdown document into chunks of about `maxChars`, keeping
 * each chunk under the nearest heading so a permission set on one section
 * stays on that section.
 */
export function chunkDocument(text: string, maxChars = 1200): KnowledgeChunkDraft[] {
  const chunks: KnowledgeChunkDraft[] = []
  let heading: string | null = null
  let buffer: string[] = []
  const flush = () => {
    const body = buffer.join("\n\n").trim()
    if (body) chunks.push({ heading, text: body })
    buffer = []
  }
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed.split("\n")[0])
    if (headingMatch) {
      flush()
      heading = headingMatch[1].trim().slice(0, 300)
      const rest = trimmed.split("\n").slice(1).join("\n").trim()
      if (rest) buffer.push(rest)
      continue
    }
    for (let start = 0; start < trimmed.length; start += maxChars) {
      const piece = trimmed.slice(start, start + maxChars)
      if (buffer.join("\n\n").length + piece.length > maxChars) flush()
      buffer.push(piece)
    }
  }
  flush()
  return chunks
}

export type KnowledgeReadDecision =
  | { allowed: true; sensitivity: KnowledgeSensitivity; ruleId: string | null }
  | { allowed: false; reason: "document" | "chunk" | "restricted"; ruleId: string | null }

function ruleIdOf(decision: AccessDecision) {
  return "ruleId" in decision ? decision.ruleId : null
}

/**
 * Whether a member may read one chunk:
 * 1. they must be able to read the document (documents are closed by default;
 *    uploading one writes allow rules for its audience);
 * 2. a deny on the chunk wins; allow rules on a chunk restrict it to their
 *    principals, like any restricted resource;
 * 3. a `restricted` chunk needs an allow rule on the chunk itself; access to
 *    the document is not enough.
 */
export function decideKnowledgeRead(input: {
  rules: readonly AccessPolicyRule[]
  principals: readonly AccessPrincipal[]
  documentId: string
  chunkId: string
  sensitivity: KnowledgeSensitivity
  now?: Date
}): KnowledgeReadDecision {
  const document = decideAccess({
    rules: input.rules,
    principals: input.principals,
    resourceKind: "knowledge_document",
    resourceId: input.documentId,
    baseline: "closed",
    now: input.now,
  })
  if (!document.allowed) return { allowed: false, reason: "document", ruleId: ruleIdOf(document) }
  const chunk = decideAccess({
    rules: input.rules,
    principals: input.principals,
    resourceKind: "knowledge_chunk",
    resourceId: input.chunkId,
    baseline: "open",
    now: input.now,
  })
  if (!chunk.allowed) return { allowed: false, reason: "chunk", ruleId: ruleIdOf(chunk) }
  if (input.sensitivity === "restricted" && chunk.via !== "policy") return { allowed: false, reason: "restricted", ruleId: null }
  return { allowed: true, sensitivity: input.sensitivity, ruleId: ruleIdOf(chunk) ?? ruleIdOf(document) }
}

export function loadKnowledgeRules(db: DenDb, organizationId: string) {
  return loadAccessPolicyRules(db, { organizationId, resourceKinds: ["knowledge_document", "knowledge_chunk"] })
}

/** Documents a member can open (at least the document rule allows them). */
export function readableDocumentIds(input: {
  rules: readonly AccessPolicyRule[]
  principals: readonly AccessPrincipal[]
  documentIds: readonly string[]
}) {
  return input.documentIds.filter((documentId) => decideAccess({
    rules: input.rules,
    principals: input.principals,
    resourceKind: "knowledge_document",
    resourceId: documentId,
    baseline: "closed",
  }).allowed)
}

export type KnowledgeSearchResult = {
  chunkId: string
  documentId: string
  documentTitle: string
  heading: string | null
  text: string
  sensitivity: KnowledgeSensitivity
  score: number
}

type OrganizationId = typeof KnowledgeDocumentTable.$inferSelect.organizationId
type DocumentId = typeof KnowledgeDocumentTable.$inferSelect.id

/**
 * Full-text search over only the chunks a member may read. Rules are loaded
 * once per search and every candidate is checked fresh (no cached decisions),
 * so a removed or expired rule takes effect on the next search. Results that
 * include sensitive or restricted chunks are recorded in the audit log.
 */
export async function searchKnowledge(db: DenDb, input: {
  context: MemberAccessContext
  query: string
  limit: number
  surface: string
}): Promise<KnowledgeSearchResult[]> {
  const query = input.query.trim()
  if (!query) return []
  const organizationId = input.context.organizationId as OrganizationId
  const rules = await loadKnowledgeRules(db, organizationId)
  const documents = await db
    .select({ id: KnowledgeDocumentTable.id, title: KnowledgeDocumentTable.title })
    .from(KnowledgeDocumentTable)
    .where(and(eq(KnowledgeDocumentTable.organizationId, organizationId), isNull(KnowledgeDocumentTable.removedAt)))
  const readable = new Set(readableDocumentIds({ rules, principals: input.context.principals, documentIds: documents.map((doc) => doc.id) }))
  if (readable.size === 0) return []
  const titles = new Map(documents.map((doc) => [doc.id, doc.title]))
  const score = sql<number>`MATCH(${KnowledgeChunkTable.heading}, ${KnowledgeChunkTable.text}) AGAINST (${query} IN NATURAL LANGUAGE MODE)`
  const candidates = await db
    .select({
      id: KnowledgeChunkTable.id,
      documentId: KnowledgeChunkTable.documentId,
      heading: KnowledgeChunkTable.heading,
      text: KnowledgeChunkTable.text,
      sensitivity: KnowledgeChunkTable.sensitivity,
      score,
    })
    .from(KnowledgeChunkTable)
    .where(and(
      eq(KnowledgeChunkTable.organizationId, organizationId),
      inArray(KnowledgeChunkTable.documentId, [...readable] as DocumentId[]),
      sql`${score} > 0`,
    ))
    .orderBy(sql`${score} DESC`)
    .limit(Math.max(input.limit * 5, 25))
  const results: KnowledgeSearchResult[] = []
  for (const chunk of candidates) {
    const decision = decideKnowledgeRead({
      rules,
      principals: input.context.principals,
      documentId: chunk.documentId,
      chunkId: chunk.id,
      sensitivity: chunk.sensitivity,
    })
    if (!decision.allowed) continue
    results.push({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle: titles.get(chunk.documentId) ?? "",
      heading: chunk.heading,
      text: chunk.text,
      sensitivity: chunk.sensitivity,
      score: Number(chunk.score),
    })
    if (results.length >= input.limit) break
  }
  const labelled = results.filter((result) => result.sensitivity !== "ordinary")
  if (labelled.length > 0 && input.context.userId) {
    await db.insert(AuditEventTable).values({
      id: createDenTypeId("auditEvent"),
      org_id: normalizeDenTypeId("org", input.context.organizationId),
      worker_id: null,
      actor_user_id: input.context.userId as typeof AuditEventTable.$inferInsert.actor_user_id,
      action: KNOWLEDGE_READ_AUDIT_ACTION,
      payload: {
        memberId: input.context.memberId,
        surface: input.surface,
        chunks: labelled.map((result) => ({ chunkId: result.chunkId, documentId: result.documentId, sensitivity: result.sensitivity })),
      },
    })
  }
  return results
}

export const KNOWLEDGE_READ_AUDIT_ACTION = "knowledge.sensitive_read"
