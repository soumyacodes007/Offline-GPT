import { eq, sql } from "drizzle-orm";
import { KIND_BASELINES, loadRules, subjectOf } from "@offlinegpt-platform/access";
import { knowledgeDocuments, knowledgeSections, type Database } from "@offlinegpt-platform/db";
import { decideMany } from "@offlinegpt-platform/policy";

export type SearchHit = {
  path: string;
  title: string;
  section: string;
  heading: string;
  text: string;
  sensitivity: "ordinary" | "sensitive" | "restricted";
};

const CANDIDATES = 200;
export const MAX_RESULTS = 20;

export function sectionId(path: string, position: number): string {
  return `${path}#${position}`;
}

/** Full-text search, then keep only what this member may read right now. See docs/platform-spec/knowledge.md. */
export async function searchKnowledge(db: Database, member: { id: string; role: "owner" | "admin" | "member" }, query: string, now: Date, limit = MAX_RESULTS): Promise<SearchHit[]> {
  const terms = sql`websearch_to_tsquery('simple', ${query})`;
  const candidates = await db
    .select({
      path: knowledgeDocuments.path,
      title: knowledgeDocuments.title,
      position: knowledgeSections.position,
      heading: knowledgeSections.heading,
      body: knowledgeSections.body,
      sensitivity: knowledgeSections.sensitivity,
    })
    .from(knowledgeSections)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeSections.documentId))
    .where(sql`${knowledgeSections.search} @@ ${terms}`)
    .orderBy(sql`ts_rank(${knowledgeSections.search}, ${terms}) desc`, knowledgeDocuments.path, knowledgeSections.position)
    .limit(CANDIDATES);
  if (!candidates.length) return [];

  const subject = await subjectOf(db, member);
  const documents = decideMany({ subject, kind: "knowledge-document", ids: [...new Set(candidates.map((row) => row.path))], rules: await loadRules(db, "knowledge-document"), baseline: KIND_BASELINES["knowledge-document"], now });
  const sections = decideMany({ subject, kind: "knowledge-section", ids: candidates.map((row) => sectionId(row.path, row.position)), rules: await loadRules(db, "knowledge-section"), baseline: KIND_BASELINES["knowledge-section"], now });

  const hits: SearchHit[] = [];
  for (const row of candidates) {
    if (!documents.get(row.path)?.allowed) continue;
    const id = sectionId(row.path, row.position);
    const section = sections.get(id);
    if (!section?.allowed) continue;
    // Restricted text needs a rule on the section itself, not just the document audience.
    if (row.sensitivity === "restricted" && section.cause.type !== "allow-rule") continue;
    hits.push({ path: row.path, title: row.title, section: id, heading: row.heading, text: row.body, sensitivity: row.sensitivity });
    if (hits.length >= limit) break;
  }
  return hits;
}
