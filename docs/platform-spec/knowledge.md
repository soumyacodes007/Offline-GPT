# Platform spec: knowledge base

## Documents and sections

- An admin uploads a document with a **path** (its resource id, e.g.
  `policies/hr/leave`), a title and its text: Markdown, plain text, PDF or
  Word (.docx). PDF and Word files are converted to text inside the network;
  Word headings become section headings.
- The text is split into **sections** at headings. A section longer than about
  1,200 characters is split again at paragraph breaks.
- Uploading the same path again replaces the document and its sections.
- A section's resource id is `<path>#<number>` (1-based).

## Who can read

- Documents use the policy kind `knowledge-document`, which is **closed**:
  nobody reads a document until an allow rule names it (directly or with a
  `prefix*`). The upload can name its audience, which becomes allow rules.
- Sections use the kind `knowledge-section`, which is **open** within a
  readable document. A deny rule hides a section; an allow rule restricts it.
- Each section has a **sensitivity**: `ordinary`, `sensitive` or `restricted`.
  A restricted section is readable only through an allow rule on that section
  itself, not through the document's audience.
- Decisions are made at search time for the member who asks; nothing is
  cached.

## Search

- `POST /v1/knowledge/search` with a query returns the best matching sections
  the member may read (Postgres full-text ranking), at most 20, each with its
  document path, title, heading, text and sensitivity.
- Every search that returns a sensitive or restricted section writes a
  `knowledge.sensitive_read` audit event naming the sections.

## For the agent

- The control service exposes an MCP endpoint at `/mcp` for workspaces,
  authenticated with the member's inference key. It offers one tool,
  `search_knowledge`, which runs the search above as that member.

## Meaning-based search (optional)

- With `EMBEDDINGS_URL` and `EMBEDDINGS_MODEL` set (any OpenAI-compatible
  embeddings endpoint inside the network), every section also gets a vector,
  and search merges keyword and meaning-based rankings (reciprocal rank
  fusion). Sections below 0.2 cosine similarity don't count as matches.
- Permission and sensitivity filtering apply to every result exactly as for
  keyword search.
- If the embeddings model is down, uploads still succeed (`embedded: false`)
  and search falls back to keywords. `POST /v1/knowledge/reindex` embeds
  missing sections; `{ "all": true }` redoes all of them after a model change.
- Vectors are stored as plain `real[]` with the similarity computed in SQL, not
  with `pgvector`: it needs no database extension or different Postgres image
  in an air-gapped install, and is fast enough for tens of thousands of
  sections. Switch to `pgvector` if a deployment outgrows that.
