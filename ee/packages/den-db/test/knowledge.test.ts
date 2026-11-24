import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { decideAccess, resourceMatches, type AccessPolicyRule, type AccessPrincipal } from "../src/access-policy.ts"
import { chunkDocument, decideKnowledgeRead } from "../src/knowledge.ts"

let n = 0
function rule(partial: Partial<AccessPolicyRule> & Pick<AccessPolicyRule, "resourceKind" | "resourceId" | "principalKind" | "principalId" | "effect">): AccessPolicyRule {
  n += 1
  return { id: `apr_${n}`, expiresAt: null, removedAt: null, ...partial }
}
const hr: AccessPrincipal[] = [{ kind: "member", id: "om_hr" }, { kind: "team", id: "tem_hr" }, { kind: "role", id: "member" }, { kind: "org", id: "org_1" }]
const clerk: AccessPrincipal[] = [{ kind: "member", id: "om_clerk" }, { kind: "team", id: "tem_ops" }, { kind: "role", id: "member" }, { kind: "org", id: "org_1" }]
const orgCanRead = rule({ resourceKind: "knowledge_document", resourceId: "kdc_1", principalKind: "org", principalId: "org_1", effect: "allow" })
const read = (rules: AccessPolicyRule[], principals: AccessPrincipal[], chunkId = "kch_1", sensitivity: "ordinary" | "sensitive" | "restricted" = "ordinary") =>
  decideKnowledgeRead({ rules, principals, documentId: "kdc_1", chunkId, sensitivity })

describe("chunkDocument", () => {
  test("keeps each section under its heading", () => {
    const chunks = chunkDocument("Intro text.\n\n# Leave policy\n\nTwelve days.\n\n## Salaries\n\nBands A to D.")
    assert.deepEqual(chunks, [
      { heading: null, text: "Intro text." },
      { heading: "Leave policy", text: "Twelve days." },
      { heading: "Salaries", text: "Bands A to D." },
    ])
  })

  test("splits long sections to the size limit", () => {
    const chunks = chunkDocument(`# Big\n\n${"a".repeat(250)}\n\n${"b".repeat(250)}`, 300)
    assert.equal(chunks.length, 2)
    assert.ok(chunks.every((chunk) => chunk.heading === "Big" && chunk.text.length <= 300))
  })
})

describe("decideKnowledgeRead", () => {
  test("documents are closed until a rule opens them", () => {
    assert.deepEqual(read([], clerk), { allowed: false, reason: "document", ruleId: null })
    assert.equal(read([orgCanRead], clerk).allowed, true)
  })

  test("a chunk deny hides one section from one team", () => {
    const rules = [orgCanRead, rule({ resourceKind: "knowledge_chunk", resourceId: "kch_2", principalKind: "team", principalId: "tem_ops", effect: "deny" })]
    assert.equal(read(rules, clerk, "kch_1").allowed, true)
    assert.equal(read(rules, clerk, "kch_2").allowed, false)
    assert.equal(read(rules, hr, "kch_2").allowed, true)
  })

  test("a chunk allow restricts that chunk to its grantees", () => {
    const rules = [orgCanRead, rule({ resourceKind: "knowledge_chunk", resourceId: "kch_2", principalKind: "team", principalId: "tem_hr", effect: "allow" })]
    assert.equal(read(rules, hr, "kch_2").allowed, true)
    assert.deepEqual(read(rules, clerk, "kch_2"), { allowed: false, reason: "chunk", ruleId: null })
  })

  test("a restricted chunk needs a rule on the chunk, not just the document", () => {
    assert.deepEqual(read([orgCanRead], hr, "kch_3", "restricted"), { allowed: false, reason: "restricted", ruleId: null })
    const rules = [orgCanRead, rule({ resourceKind: "knowledge_chunk", resourceId: "kch_3", principalKind: "member", principalId: "om_hr", effect: "allow" })]
    assert.equal(read(rules, hr, "kch_3", "restricted").allowed, true)
  })

  test("a chunk grant never opens a document the member cannot read", () => {
    const rules = [rule({ resourceKind: "knowledge_chunk", resourceId: "kch_1", principalKind: "member", principalId: "om_clerk", effect: "allow" })]
    assert.equal(read(rules, clerk).allowed, false)
  })
})

describe("resource patterns", () => {
  test("prefix* matches ids that start with the prefix", () => {
    assert.equal(resourceMatches("mcp:conn_1:*", "mcp:conn_1:send_mail"), true)
    assert.equal(resourceMatches("mcp:conn_1:*", "mcp:conn_2:send_mail"), false)
    assert.equal(resourceMatches("*", "anything"), true)
    const rules = [rule({ resourceKind: "capability", resourceId: "mcp:conn_1:*", principalKind: "org", principalId: "org_1", effect: "deny" })]
    assert.equal(decideAccess({ rules, principals: clerk, resourceKind: "capability", resourceId: "mcp:conn_1:send_mail", baseline: "granted" }).allowed, false)
  })
})
