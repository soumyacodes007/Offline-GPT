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
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
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
  const unenforced = await request(owner, "/v1/access-policy/rules", "POST", { ...denyRule, resourceKind: "llm_provider" });
  expect(unenforced.response.status).toBe(400);
  evidence.recordAssertionEvidence("Rule writes are guarded", "A member's POST /v1/access-policy/rules got 403; an unknown member principal and a kind that is not enforced each got 400.", true);

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

});
