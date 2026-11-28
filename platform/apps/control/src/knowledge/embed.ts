import { and, eq, isNull } from "drizzle-orm";
import { knowledgeSections } from "@offlinegpt-platform/db";
import { z } from "zod";
import type { Deps } from "../deps";

/**
 * Meaning-based search support: texts become unit-length vectors from the
 * deployment's OpenAI-compatible embeddings endpoint, so a dot product is the
 * cosine similarity. Optional: without EMBEDDINGS_URL search is keyword-only.
 */
const BATCH = 32;
const MAX_CHARS = 8000;
const responseSchema = z.object({ data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })) });

function unit(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length ? vector.map((value) => value / length) : vector;
}

export async function embedTexts(deps: Deps, texts: string[]): Promise<number[][]> {
  const embeddings = deps.config.embeddings;
  if (!embeddings) throw new Error("No embeddings model is set up.");
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const input = texts.slice(start, start + BATCH).map((text) => text.slice(0, MAX_CHARS));
    const response = await deps.fetch(`${embeddings.url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: embeddings.model, input }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`The embeddings model answered HTTP ${response.status}.`);
    const parsed = responseSchema.parse(await response.json());
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    if (ordered.length !== input.length) throw new Error("The embeddings model returned the wrong number of vectors.");
    vectors.push(...ordered.map((item) => unit(item.embedding)));
  }
  return vectors;
}

/** Embed sections that have no vector yet (all of a document's, or every missing one). Returns how many were embedded. */
export async function embedMissingSections(deps: Deps, documentId?: string): Promise<number> {
  if (!deps.config.embeddings) return 0;
  const missing = await deps.db
    .select({ id: knowledgeSections.id, heading: knowledgeSections.heading, body: knowledgeSections.body })
    .from(knowledgeSections)
    .where(and(isNull(knowledgeSections.embedding), ...(documentId ? [eq(knowledgeSections.documentId, documentId)] : [])));
  if (!missing.length) return 0;
  const vectors = await embedTexts(deps, missing.map((section) => `${section.heading}\n${section.body}`));
  for (const [index, section] of missing.entries()) {
    const vector = vectors[index];
    if (vector) await deps.db.update(knowledgeSections).set({ embedding: vector }).where(eq(knowledgeSections.id, section.id));
  }
  return missing.length;
}

/** Drop every vector, e.g. after switching models (vectors from different models can't be compared). */
export async function clearEmbeddings(deps: Deps): Promise<void> {
  await deps.db.update(knowledgeSections).set({ embedding: null });
}
