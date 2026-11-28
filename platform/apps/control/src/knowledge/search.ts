import { eq, isNotNull, sql } from "drizzle-orm";
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
/** Reciprocal rank fusion constant: how much lower ranks still count. */
const FUSION_K = 60;
/** Below this cosine similarity a section isn't about the question at all. */
const MIN_SIMILARITY = 0.2;
export const MAX_RESULTS = 20;

export function sectionId(path: string, position: number): string {
  return `${path}#${position}`;
}

const candidateColumns = {
  path: knowledgeDocuments.path,
  title: knowledgeDocuments.title,
  position: knowledgeSections.position,
  heading: knowledgeSections.heading,
  body: knowledgeSections.body,
  sensitivity: knowledgeSections.sensitivity,
};
type Candidate = { path: string; title: string; position: number; heading: string; body: string; sensitivity: SearchHit["sensitivity"] };

/** Sections nearest in meaning to the question's vector, best first. */
async function semanticCandidates(db: Database, queryVector: number[]): Promise<Candidate[]> {
  const vector = `{${queryVector.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}}`;
  const similarity = sql<number>`(select sum(e * q) from unnest(${knowledgeSections.embedding}, ${vector}::real[]) as pairs(e, q))`;
  const rows = await db
    .select({ ...candidateColumns, similarity })
    .from(knowledgeSections)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeSections.documentId))
    .where(isNotNull(knowledgeSections.embedding))
    .orderBy(sql`${similarity} desc`)
    .limit(CANDIDATES);
  return rows.filter((row) => Number(row.similarity) >= MIN_SIMILARITY);
}

/** Merge ranked lists by reciprocal rank fusion, keeping each section once. */
function fuse(lists: Candidate[][]): Candidate[] {
  const scores = new Map<string, { row: Candidate; score: number }>();
  for (const list of lists) {
    for (const [rank, row] of list.entries()) {
      const key = sectionId(row.path, row.position);
      const entry = scores.get(key) ?? { row, score: 0 };
      entry.score += 1 / (FUSION_K + rank + 1);
      scores.set(key, entry);
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((entry) => entry.row);
}

/**
 * Keyword search, plus meaning-based search when a query vector is given, then
 * keep only what this member may read right now. See docs/platform-spec/knowledge.md.
 */
export async function searchKnowledge(db: Database, member: { id: string; role: "owner" | "admin" | "member" }, query: string, now: Date, limit = MAX_RESULTS, queryVector?: number[]): Promise<SearchHit[]> {
  const terms = sql`websearch_to_tsquery('simple', ${query})`;
  const keyword = await db
    .select(candidateColumns)
    .from(knowledgeSections)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeSections.documentId))
    .where(sql`${knowledgeSections.search} @@ ${terms}`)
    .orderBy(sql`ts_rank(${knowledgeSections.search}, ${terms}) desc`, knowledgeDocuments.path, knowledgeSections.position)
    .limit(CANDIDATES);
  const candidates = queryVector ? fuse([keyword, await semanticCandidates(db, queryVector)]) : keyword;
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
