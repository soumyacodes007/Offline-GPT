import { expect } from "vitest";
import { denFetch, type DenSession } from "@offlinegpt/behaviors";
import { mcpMock, queryDenDatabase } from "@offlinegpt/env";
import { server, test } from "@offlinegpt/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

test("admins manage qm-style access policy rules and members feel them at once", { timeout: 600_000 }, async ({ place, evidence }) => {
  await using den = await server({
    place,
    web: false,
    // The harness seeds a multi-org Den, which the air-gapped edition refuses; access
    // policy itself is edition-independent (air-gapped boot rules: den-api env tests).
    // DEN_WEB_PUBLIC_ORIGIN: refusals link to the portal's prefilled request form.
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1", DEN_WEB_PUBLIC_ORIGIN: "http://portal.psu.test" },
    mocks: { archive: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: { name: "Access Policy PSU", members: { asha: {}, ravi: {} } },
  });
  const owner = den.admin;
  const asha = den.members.asha;
  const ravi = den.members.ravi;
  if (!asha || !ravi) throw new Error("Missing test members");
  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Access Policy PSU")).id);
  const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-offlinegpt-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const memberId = async (session: DenSession) => text(record(record((await request(session, "/v1/org")).body).currentMember).id);
  const ashaId = await memberId(asha);
  const archive = den.mocks.archive;
  if (!archive) throw new Error("Missing MCP mock");

  // An org-wide MCP connection both members can use.
  const created = await request(owner, "/v1/mcp-connections", "POST", {
    name: "Tender archive", url: archive.mcpUrl, authType: "none",
    access: { orgWide: true, memberIds: [], teamIds: [] },
  });
  expect(created.response.status, created.text).toBeLessThan(300);
  const connectionId = text(record(created.body).id);
  const usable = async (session: DenSession) => {
    const result = await request(session, "/v1/mcp-connections");
    expect(result.response.status, result.text).toBe(200);
    const connections = record(result.body).connections;
    return Array.isArray(connections) ? connections.map((connection) => record(connection).id) : [];
  };
  expect(await usable(asha)).toContain(connectionId);
  expect(await usable(ravi)).toContain(connectionId);

  // Only owners and super-admins write rules; unknown principals and unenforced kinds are refused.
  const denyRule = { resourceKind: "mcp_connection", resourceId: connectionId, principalKind: "member", principalId: ashaId, effect: "deny", reason: "Moved to another department" };
  const byMember = await request(asha, "/v1/access-policy/rules", "POST", denyRule);
  expect(byMember.response.status).toBe(403);
  const badPrincipal = await request(owner, "/v1/access-policy/rules", "POST", { ...denyRule, principalId: "om_01doesnotexist00000000000" });
  expect(badPrincipal.response.status).toBe(400);
  const unknownKind = await request(owner, "/v1/access-policy/rules", "POST", { ...denyRule, resourceKind: "billing" });
  expect(unknownKind.response.status).toBe(400);
  evidence.recordAssertionEvidence("Rule writes are guarded", "A member's POST /v1/access-policy/rules got 403; an unknown member principal and an unknown resource kind each got 400.", true);

  const createdRule = await request(owner, "/v1/access-policy/rules", "POST", denyRule);
  expect(createdRule.response.status, createdRule.text).toBe(201);
  const ruleId = text(record(record(createdRule.body).rule).id);
  const listed = record((await request(owner, "/v1/access-policy/rules?resourceKind=mcp_connection")).body).rules;
  expect(Array.isArray(listed) && listed.map((rule) => record(rule).id)).toContain(ruleId);

  // The deny applies on the member's very next request; the other member is unaffected.
  expect(await usable(asha)).not.toContain(connectionId);
  expect(await usable(ravi)).toContain(connectionId);
  const explained = record((await request(owner, "/v1/access-policy/check", "POST", { memberId: ashaId, resourceKind: "mcp_connection", resourceId: connectionId })).body);
  expect(record(explained.decision)).toEqual({ allowed: false, via: "policy", ruleId });
  evidence.recordAssertionEvidence("A deny rule removes a granted connection for one member", `With an org-wide grant in place, a member-level deny hid "Tender archive" from Asha's usable connections while Ravi kept it, and /v1/access-policy/check named rule ${ruleId}.`, true);

  // Removing the rule restores access, and both changes are in the audit log.
  const removed = await request(owner, `/v1/access-policy/rules/${ruleId}`, "DELETE");
  expect(removed.response.status).toBe(204);
  expect(await usable(asha)).toContain(connectionId);
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("Den database URL is unavailable");
  const audit = await queryDenDatabase(databaseUrl, "SELECT action FROM audit_event WHERE org_id = ? AND action LIKE 'organization.access_policy.%' ORDER BY created_at", [orgId]);
  expect(audit.map((row) => record(row).action)).toEqual(["organization.access_policy.rule_created", "organization.access_policy.rule_removed"]);
  evidence.recordAssertionEvidence("Rule changes are reversible and audited", "DELETE returned 204, Asha's access came back on the next request, and audit_event holds rule_created then rule_removed for the org.", true);

  // Request and approval, as in qm: a member asks with a reason, an approver decides, approval writes a time-bound rule.
  const ravisOnly = await request(owner, "/v1/mcp-connections", "POST", {
    name: "Payroll archive", url: archive.mcpUrl, authType: "none",
    access: { orgWide: false, memberIds: [await memberId(ravi)], teamIds: [] },
  });
  expect(ravisOnly.response.status, ravisOnly.text).toBeLessThan(300);
  const payrollId = text(record(ravisOnly.body).id);
  expect(await usable(asha)).not.toContain(payrollId);
  const ask = { resourceKind: "mcp_connection", resourceId: payrollId, resourceLabel: "Payroll archive", purpose: "Monthly payroll reconciliation", requestedDays: 1 };
  const asked = await request(asha, "/v1/access-requests", "POST", ask);
  expect(asked.response.status, asked.text).toBe(201);
  const requestId = text(record(record(asked.body).request).id);
  const again = await request(asha, "/v1/access-requests", "POST", ask);
  expect(again.response.status).toBe(200);
  expect(record(record(again.body).request).id).toBe(requestId);
  const inbox = record((await request(owner, "/v1/access-requests?scope=all&status=pending")).body).requests;
  expect(Array.isArray(inbox) && inbox.map((row) => record(row).id)).toContain(requestId);
  expect((await request(asha, "/v1/access-requests?scope=all")).response.status).toBe(403);
  expect((await request(asha, `/v1/access-requests/${requestId}/approve`, "POST", {})).response.status).toBe(403);
  const approved = await request(owner, `/v1/access-requests/${requestId}/approve`, "POST", { note: "For this month's run" });
  expect(approved.response.status, approved.text).toBe(200);
  const grantRuleId = text(record(approved.body).ruleId);
  expect(await usable(asha)).toContain(payrollId);
  const allRules = record((await request(owner, "/v1/access-policy/rules?resourceKind=mcp_connection")).body).rules;
  const grantRule = record((Array.isArray(allRules) ? allRules : []).map(record).find((rule) => rule.id === grantRuleId));
  expect(grantRule).toMatchObject({ effect: "allow", principalKind: "member", principalId: ashaId });
  const hoursLeft = (new Date(text(grantRule.expiresAt)).getTime() - Date.now()) / 3_600_000;
  expect(hoursLeft).toBeGreaterThan(23);
  expect(hoursLeft).toBeLessThanOrEqual(24);
  const twice = await request(owner, `/v1/access-requests/${requestId}/approve`, "POST", {});
  expect(twice.response.status).toBe(409);
  const mine = record((await request(asha, "/v1/access-requests")).body).requests;
  expect(record((Array.isArray(mine) ? mine : []).map(record).find((row) => row.id === requestId))).toMatchObject({ status: "approved", decisionNote: "For this month's run", grantedRuleId: grantRuleId });
  evidence.recordAssertionEvidence("A member requests access and an approver grants it for the asked time", `Asha could not use "Payroll archive" (shared only with Ravi). Her request (reason "Monthly payroll reconciliation", 1 day) appeared in the owner's inbox; a repeat request returned the same one; Asha could not list everyone's requests or approve (403). The owner's approval wrote allow rule ${grantRuleId} for Asha ending in ${hoursLeft.toFixed(1)} h, she could use the connection on her next request, a second approval got 409, and her own list shows approved with the note.`, true);

  const declineAsk = await request(ravi, "/v1/access-requests", "POST", { ...ask, resourceId: connectionId, resourceLabel: "Tender archive", purpose: "Curious" });
  const declineId = text(record(record(declineAsk.body).request).id);
  const declined = await request(owner, `/v1/access-requests/${declineId}/decline`, "POST", { note: "You already have it" });
  expect(declined.response.status, declined.text).toBe(200);
  expect(record(record(declined.body).request).status).toBe("declined");
  expect((await request(owner, `/v1/access-requests/${declineId}/approve`, "POST", {})).response.status).toBe(409);
  const decisions = await queryDenDatabase(databaseUrl, "SELECT action FROM audit_event WHERE org_id = ? AND action LIKE 'organization.access_request.%' ORDER BY created_at", [orgId]);
  expect(decisions.map((row) => record(row).action)).toEqual([
    "organization.access_request.created", "organization.access_request.approved", "organization.access_request.created", "organization.access_request.declined",
  ]);
  evidence.recordAssertionEvidence("Declines are final and every decision is audited", "Ravi's request was declined with a note, could not be approved afterwards (409), and audit_event holds created, approved, created, declined.", true);

  // A capability rule blocks one connection's tool actions in the MCP gateway, for search and execute.
  const gateway = async (session: DenSession, name: string, args: Record<string, unknown>) => {
    const minted = await request(session, "/v1/mcp/token", "POST", {});
    expect(minted.response.status, minted.text).toBe(200);
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${text(record(minted.body).token)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    const result = record(record(JSON.parse(line ? line.slice(5) : raw)).result);
    const content = result.content;
    const first = Array.isArray(content) ? record(content[0]) : {};
    return { result, text: typeof first.text === "string" ? first.text : "" };
  };
  const toolMatches = async (session: DenSession) => {
    const found = await gateway(session, "search_capabilities", { query: "Tender archive", type: "mcp", limit: 20 });
    const matches = record(JSON.parse(found.text)).matches;
    return (Array.isArray(matches) ? matches : []).map((match) => String(record(match).name)).filter((name) => name.startsWith(`mcp:${connectionId}:`));
  };
  const before = await toolMatches(asha);
  expect(before.length).toBeGreaterThan(0);
  const capabilityRule = await request(owner, "/v1/access-policy/rules", "POST", { resourceKind: "capability", resourceId: `mcp:${connectionId}:*`, principalKind: "member", principalId: ashaId, effect: "deny", reason: "Read-only role" });
  expect(capabilityRule.response.status, capabilityRule.text).toBe(201);
  expect(await toolMatches(asha)).toEqual([]);
  expect((await toolMatches(ravi)).length).toBeGreaterThan(0);
  const blocked = await gateway(asha, "execute_capability", { name: before[0], body: {} });
  expect(blocked.result.isError).toBe(true);
  expect(record(blocked.result.structuredContent)).toEqual({ error: "access_policy_denied", capability: before[0] });
  const link = /http:\/\/portal\.psu\.test\/\S+/.exec(blocked.text)?.[0];
  expect(link, blocked.text).toBeDefined();
  const linkUrl = new URL(link ?? "");
  expect([linkUrl.pathname, linkUrl.searchParams.get("kind"), linkUrl.searchParams.get("id")]).toEqual(["/dashboard/my-access", "capability", before[0]]);
  const denials = await queryDenDatabase(databaseUrl, "SELECT payload FROM audit_event WHERE org_id = ? AND action = 'access_policy.denied'", [orgId]);
  expect(denials.map((row) => JSON.stringify(record(row).payload)).some((payload) => payload.includes("mcp_execute_capability"))).toBe(true);
  evidence.recordAssertionEvidence("A capability rule blocks one connection's actions in the MCP gateway", `Before the rule, search_capabilities returned ${before.length} "Tender archive" actions to Asha. A deny on mcp:${connectionId}:* removed all of them from her search while Ravi still saw them; executing ${before[0]} returned access_policy_denied with a one-click request link (${linkUrl.pathname}?kind=capability&id=…), and the refusal was recorded as access_policy.denied (surface mcp_execute_capability).`, true);

  // The portal names things instead of asking for ids: members get what they could ask for, admins get more.
  const resourcesOf = async (session: DenSession) => {
    const listed = await request(session, "/v1/access-policy/resources");
    expect(listed.response.status, listed.text).toBe(200);
    const resources = record(listed.body).resources;
    return (Array.isArray(resources) ? resources : []).map((resource) => record(resource));
  };
  const memberView = await resourcesOf(ravi);
  const adminView = await resourcesOf(owner);
  expect(memberView).toContainEqual({ kind: "mcp_connection", id: connectionId, label: "Tender archive" });
  expect(memberView.some((resource) => resource.kind === "capability" || resource.kind === "knowledge_document")).toBe(false);
  expect(adminView).toContainEqual({ kind: "capability", id: `mcp:${connectionId}:*`, label: "Tender archive (all tools)" });
  evidence.recordAssertionEvidence("Resources are listed by name for pickers", `GET /v1/access-policy/resources gave Ravi (member) the connection as "Tender archive" and no tools or documents; the owner also got "Tender archive (all tools)" for mcp:${connectionId}:*.`, true);

  // Model provider rules: a deny removes a shared provider; an allow gives one nobody was granted.
  const newProvider = async (key: string, allMembers: boolean) => {
    const made = await request(owner, "/v1/llm-providers", "POST", {
      name: `Plant ${key}`, source: "custom",
      customConfig: { id: key, name: `Plant ${key}`, npm: "@ai-sdk/openai-compatible", env: ["PLANT_API_KEY"], models: [{ id: `${key}-model`, name: "Plant model" }] },
      allMembers, memberIds: [],
    });
    expect(made.response.status, made.text).toBe(201);
    return text(record(record(made.body).llmProvider).id);
  };
  const providersOf = async (session: DenSession) => {
    const listedProviders = record((await request(session, "/v1/llm-providers")).body).llmProviders;
    return (Array.isArray(listedProviders) ? listedProviders : []).map((provider) => record(provider).id);
  };
  const shared = await newProvider("plantshared", true);
  const unshared = await newProvider("plantprivate", false);
  expect(await providersOf(asha)).toContain(shared);
  expect(await providersOf(ravi)).not.toContain(unshared);
  expect((await request(owner, "/v1/access-policy/rules", "POST", { resourceKind: "llm_provider", resourceId: shared, principalKind: "member", principalId: ashaId, effect: "deny" })).response.status).toBe(201);
  expect((await request(owner, "/v1/access-policy/rules", "POST", { resourceKind: "llm_provider", resourceId: unshared, principalKind: "member", principalId: await memberId(ravi), effect: "allow" })).response.status).toBe(201);
  expect(await providersOf(asha)).not.toContain(shared);
  expect(await providersOf(ravi)).toContain(shared);
  expect(await providersOf(ravi)).toContain(unshared);
  expect(await providersOf(asha)).not.toContain(unshared);
  evidence.recordAssertionEvidence("Model provider rules change who can use a provider", "A deny removed the org-wide \"Plant plantshared\" provider from Asha's usable providers while Ravi kept it; an allow gave Ravi \"Plant plantprivate\", which was shared with nobody, and Asha still could not see it.", true);
});
