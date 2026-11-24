import { expect } from "vitest";
import { denFetch, type DenSession } from "@offlinegpt/behaviors";
import { queryDenDatabase } from "@offlinegpt/env";
import { server, test } from "@offlinegpt/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

const HANDBOOK = [
  "# Leave policy",
  "Every employee gets twenty-four days of earned leave per year. Leave carries over up to sixty days.",
  "# Salary bands",
  "Band A starts at forty thousand. Band D is reserved for plant heads. Salary revisions happen in April.",
  "# Disciplinary cases",
  "Open disciplinary cases are reviewed by the HR head every Friday. Case files stay sealed.",
].join("\n\n");

test("the knowledge base answers each employee only from sections they may read", { timeout: 600_000 }, async ({ place, evidence }) => {
  await using den = await server({
    place,
    web: false,
    org: { name: "Knowledge PSU", members: { meera: {}, kiran: {} } },
  });
  const owner = den.admin;
  const meera = den.members.meera;
  const kiran = den.members.kiran;
  if (!meera || !kiran) throw new Error("Missing test members");
  const orgs = list(record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs);
  const orgId = text(orgs.find((org) => org.name === "Knowledge PSU")?.id);
  const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-offlinegpt-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const memberId = async (session: DenSession) => text(record(record((await request(session, "/v1/org")).body).currentMember).id);
  const meeraId = await memberId(meera);
  const team = await request(owner, "/v1/teams", "POST", { name: "HR", memberIds: [meeraId] });
  expect(team.response.status, team.text).toBeLessThan(300);
  const hrTeamId = text(record(record(team.body).team).id);

  // Members cannot add knowledge; the owner adds the handbook for everyone.
  const handbook = { title: "Employee handbook", text: HANDBOOK };
  expect((await request(kiran, "/v1/knowledge/documents", "POST", handbook)).response.status).toBe(403);
  const created = await request(owner, "/v1/knowledge/documents", "POST", handbook);
  expect(created.response.status, created.text).toBe(201);
  expect(record(created.body).chunkCount).toBe(3);
  const documentId = text(record(record(created.body).document).id);
  const detail = record((await request(owner, `/v1/knowledge/documents/${documentId}`)).body);
  const sections = new Map(list(detail.chunks).map((chunk) => [text(chunk.heading), text(chunk.id)]));
  expect([...sections.keys()]).toEqual(["Leave policy", "Salary bands", "Disciplinary cases"]);

  // Salary bands: only HR may read. Disciplinary cases: restricted, and only Meera is named.
  const salaryRule = await request(owner, "/v1/access-policy/rules", "POST", { resourceKind: "knowledge_chunk", resourceId: sections.get("Salary bands"), principalKind: "team", principalId: hrTeamId, effect: "allow" });
  expect(salaryRule.response.status, salaryRule.text).toBe(201);
  expect((await request(owner, `/v1/knowledge/chunks/${sections.get("Disciplinary cases")}`, "PATCH", { sensitivity: "restricted" })).response.status).toBe(200);
  expect((await request(owner, `/v1/knowledge/chunks/${sections.get("Leave policy")}`, "PATCH", { sensitivity: "sensitive" })).response.status).toBe(200);

  // What each member gets back from the same searches, through the Den API and through the agent's MCP tool.
  const search = async (session: DenSession, query: string) => {
    const result = await request(session, "/v1/knowledge/search", "POST", { query });
    expect(result.response.status, result.text).toBe(200);
    return list(record(result.body).results).map((row) => text(row.heading));
  };
  const agentSearch = async (session: DenSession, query: string) => {
    const minted = await request(session, "/v1/mcp/token", "POST", {});
    expect(minted.response.status, minted.text).toBe(200);
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${text(record(minted.body).token)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_knowledge", arguments: { query } } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    const result = record(record(JSON.parse(line ? line.slice(5) : raw)).result);
    const first = list(result.content)[0];
    return list(record(JSON.parse(text(first?.text))).results).map((row) => text(row.heading));
  };
  const query = "leave salary band disciplinary cases";
  expect((await search(kiran, query)).sort()).toEqual(["Leave policy"]);
  expect((await search(meera, query)).sort()).toEqual(["Leave policy", "Salary bands"]);
  expect((await agentSearch(kiran, "salary band revisions April"))).toEqual([]);
  expect((await agentSearch(meera, "salary band revisions April"))).toEqual(["Salary bands"]);
  evidence.recordAssertionEvidence("Section rules filter search for each member", `The handbook was split into 3 sections. With "Salary bands" limited to the HR team and "Disciplinary cases" restricted, the same search returned only "Leave policy" to Kiran and "Leave policy" + "Salary bands" to Meera (HR). The agent's search_knowledge tool in the MCP gateway gave the same split: nothing for Kiran on salary bands, the "Salary bands" section for Meera.`, true);

  // A restricted section needs a rule on the section itself; reading the document is not enough.
  const restrictedRule = await request(owner, "/v1/access-policy/rules", "POST", { resourceKind: "knowledge_chunk", resourceId: sections.get("Disciplinary cases"), principalKind: "member", principalId: meeraId, effect: "allow" });
  expect(restrictedRule.response.status).toBe(201);
  expect(await search(meera, "disciplinary cases sealed")).toContain("Disciplinary cases");
  expect(await search(kiran, "disciplinary cases sealed")).not.toContain("Disciplinary cases");
  const kiranView = record((await request(kiran, `/v1/knowledge/documents/${documentId}`)).body);
  expect(list(kiranView.chunks).map((chunk) => chunk.heading)).toEqual(["Leave policy"]);
  expect(kiranView.hiddenCount).toBe(2);
  evidence.recordAssertionEvidence("Restricted sections need a named reader", "Disciplinary cases stayed hidden from everyone until a rule named Meera on that section; then only Meera found it. Opening the document as Kiran showed just Leave policy and said 2 sections are hidden.", true);

  // Removing the document's audience closes the whole document at once.
  const audience = list(record(record((await request(owner, `/v1/knowledge/documents/${documentId}`)).body).document).audience);
  expect(audience).toHaveLength(1);
  expect(audience[0]).toMatchObject({ principalKind: "org", principalId: orgId, effect: "allow" });
  expect((await request(owner, `/v1/access-policy/rules/${text(audience[0]?.id)}`, "DELETE")).response.status).toBe(204);
  expect(await search(meera, query)).toEqual([]);
  expect((await request(meera, `/v1/knowledge/documents/${documentId}`)).response.status).toBe(404);
  evidence.recordAssertionEvidence("Documents are closed without an audience", "After the owner removed the document's only audience rule (everyone), Meera's next search returned nothing and opening the document returned 404, even though she still held section rules.", true);

  // Sensitive reads are audited; removal deletes the text.
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("Den database URL is unavailable");
  const reads = await queryDenDatabase(databaseUrl, "SELECT payload FROM audit_event WHERE org_id = ? AND action = 'knowledge.sensitive_read'", [orgId]);
  expect(reads.length).toBeGreaterThan(0);
  expect((await request(owner, `/v1/knowledge/documents/${documentId}`, "DELETE")).response.status).toBe(204);
  const left = await queryDenDatabase(databaseUrl, "SELECT COUNT(*) AS n FROM knowledge_chunk WHERE document_id = ?", [documentId]);
  expect(Number(record(left[0]).n)).toBe(0);
  const changes = await queryDenDatabase(databaseUrl, "SELECT action FROM audit_event WHERE org_id = ? AND action LIKE 'organization.knowledge.%' ORDER BY created_at", [orgId]);
  expect(changes.map((row) => record(row).action)).toEqual([
    "organization.knowledge.document_created", "organization.knowledge.chunk_labelled", "organization.knowledge.chunk_labelled", "organization.knowledge.document_removed",
  ]);
  evidence.recordAssertionEvidence("Sensitive reads and knowledge changes are audited", `Searches that returned the sensitive Leave policy section wrote ${reads.length} knowledge.sensitive_read audit events. Removing the document deleted all its sections from knowledge_chunk, and audit_event holds document_created, two chunk_labelled, document_removed.`, true);
});
