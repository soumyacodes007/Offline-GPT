import { asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { accessRules, knowledgeDocuments, knowledgeSections, members, teams } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";
import { splitIntoSections } from "../knowledge/chunk";
import { extractUploadText } from "../knowledge/extract";
import { MAX_RESULTS, searchKnowledge, type SearchHit } from "../knowledge/search";
import type { Member } from "../sessions";

const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("member"), id: z.string().min(1) }),
  z.object({ type: z.literal("team"), id: z.string().min(1) }),
  z.object({ type: z.literal("role"), id: z.enum(["owner", "admin", "member"]) }),
]);

const uploadSchema = z.object({
  path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,254}$/, "Use letters, numbers, `/`, `-`, `_` and `.` for the path."),
  title: z.string().trim().min(1).max(300),
  /** Plain text or Markdown. Give this, or `file` for PDF and Word. */
  content: z.string().min(1).max(2_000_000).optional(),
  file: z.object({ format: z.enum(["pdf", "docx", "text"]), base64: z.string().min(1).max(28_000_000) }).optional(),
  audience: z.array(audienceSchema).max(50).default([]),
}).refine((body) => (body.content === undefined) !== (body.file === undefined), "Send either `content` or `file`.");
const sensitivitySchema = z.object({ sensitivity: z.enum(["ordinary", "sensitive", "restricted"]) });
const searchSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(MAX_RESULTS).default(10) });

/** Search as a member and audit any sensitive or restricted text it returns. Shared with the MCP tool. */
export async function searchAsMember(deps: Deps, member: Member, query: string, limit: number): Promise<SearchHit[]> {
  const hits = await searchKnowledge(deps.db, member, query, deps.now(), limit);
  const sensitive = hits.filter((hit) => hit.sensitivity !== "ordinary").map((hit) => hit.section);
  if (sensitive.length) await audit(deps, member.id, "knowledge.sensitive_read", { query, sections: sensitive });
  return hits;
}

export function registerKnowledgeRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/v1/knowledge/documents", access(deps, { permission: "knowledge" }), async (c) => {
    const body = await readJson(c, uploadSchema);
    let text = body.content ?? "";
    if (body.file) {
      try {
        text = await extractUploadText(body.file.format, Buffer.from(body.file.base64, "base64"));
      } catch {
        fail(400, "unreadable_file", `This ${body.file.format.toUpperCase()} file couldn't be read. Check that it isn't damaged or password-protected.`);
      }
    }
    const sections = splitIntoSections(body.title, text);
    if (!sections.length) fail(400, "empty_document", "The document has no text.");
    const memberIds = body.audience.flatMap((entry) => (entry.type === "member" ? [entry.id] : []));
    const teamIds = body.audience.flatMap((entry) => (entry.type === "team" ? [entry.id] : []));
    if (memberIds.length && (await deps.db.select({ id: members.id }).from(members).where(inArray(members.id, memberIds))).length !== new Set(memberIds).size) fail(400, "unknown_member", "An audience member doesn't exist.");
    if (teamIds.length && (await deps.db.select({ id: teams.id }).from(teams).where(inArray(teams.id, teamIds))).length !== new Set(teamIds).size) fail(400, "unknown_team", "An audience team doesn't exist.");

    const actor = c.get("member").id;
    const now = deps.now();
    const id = newId("doc");
    await deps.db.transaction(async (tx) => {
      // Uploading the same path replaces the document; its access rules stay.
      await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.path, body.path));
      await tx.insert(knowledgeDocuments).values({ id, path: body.path, title: body.title, createdBy: actor, createdAt: now });
      await tx.insert(knowledgeSections).values(sections.map((section, index) => ({ id: newId("sec"), documentId: id, position: index + 1, heading: section.heading, body: section.body })));
      if (body.audience.length) {
        await tx.insert(accessRules).values(body.audience.map((entry) => ({
          id: newId("rule"), kind: "knowledge-document", target: body.path, effect: "allow" as const, principalType: entry.type,
          principalRef: entry.type === "everyone" ? null : entry.id, expiresAt: null, reason: `Audience of "${body.title}"`, createdBy: actor, createdAt: now,
        })));
      }
    });
    await audit(deps, actor, "knowledge.document.uploaded", { documentId: id, path: body.path, sections: sections.length });
    return c.json({ document: { id, path: body.path, title: body.title, sections: sections.length } }, 201);
  });

  app.get("/v1/knowledge/documents", access(deps, { permission: "knowledge" }), async (c) => {
    const rows = await deps.db
      .select({ id: knowledgeDocuments.id, path: knowledgeDocuments.path, title: knowledgeDocuments.title, createdAt: knowledgeDocuments.createdAt, sections: count(knowledgeSections.id) })
      .from(knowledgeDocuments)
      .leftJoin(knowledgeSections, eq(knowledgeSections.documentId, knowledgeDocuments.id))
      .groupBy(knowledgeDocuments.id)
      .orderBy(desc(knowledgeDocuments.createdAt));
    return c.json({ documents: rows });
  });

  app.get("/v1/knowledge/documents/:id", access(deps, { permission: "knowledge" }), async (c) => {
    const [document] = await deps.db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, c.req.param("id"))).limit(1);
    if (!document) fail(404, "not_found", "No document with that id.");
    const sections = await deps.db
      .select({ id: knowledgeSections.id, position: knowledgeSections.position, heading: knowledgeSections.heading, body: knowledgeSections.body, sensitivity: knowledgeSections.sensitivity })
      .from(knowledgeSections)
      .where(eq(knowledgeSections.documentId, document.id))
      .orderBy(asc(knowledgeSections.position));
    return c.json({ document, sections: sections.map((section) => ({ ...section, resourceId: `${document.path}#${section.position}` })) });
  });

  app.delete("/v1/knowledge/documents/:id", access(deps, { permission: "knowledge" }), async (c) => {
    const deleted = await deps.db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, c.req.param("id"))).returning({ id: knowledgeDocuments.id, path: knowledgeDocuments.path });
    if (!deleted[0]) fail(404, "not_found", "No document with that id.");
    await audit(deps, c.get("member").id, "knowledge.document.deleted", { documentId: deleted[0].id, path: deleted[0].path });
    return c.body(null, 204);
  });

  app.patch("/v1/knowledge/sections/:id", access(deps, { permission: "knowledge" }), async (c) => {
    const body = await readJson(c, sensitivitySchema);
    const updated = await deps.db.update(knowledgeSections).set({ sensitivity: body.sensitivity }).where(eq(knowledgeSections.id, c.req.param("id"))).returning({ id: knowledgeSections.id });
    if (!updated[0]) fail(404, "not_found", "No section with that id.");
    await audit(deps, c.get("member").id, "knowledge.section.labelled", { sectionId: updated[0].id, sensitivity: body.sensitivity });
    return c.json({ id: updated[0].id, sensitivity: body.sensitivity });
  });

  app.post("/v1/knowledge/search", access(deps, "member"), async (c) => {
    const body = await readJson(c, searchSchema);
    return c.json({ results: await searchAsMember(deps, c.get("member"), body.query, body.limit) });
  });
}
