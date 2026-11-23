import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { decideAccess, type AccessBaseline, type AccessPolicyRule, type AccessPrincipal } from "../src/access-policy.ts"

function includes(actual: object, expected: object) {
  assert.deepEqual({ ...actual, ...expected }, actual)
}

const now = new Date("2026-11-24T00:00:00Z")
let n = 0
function rule(partial: Partial<AccessPolicyRule> & Pick<AccessPolicyRule, "principalKind" | "principalId" | "effect">): AccessPolicyRule {
  n += 1
  return { id: `apr_${n}`, resourceKind: "model", resourceId: "coder", expiresAt: null, removedAt: null, ...partial }
}
const itEngineer: AccessPrincipal[] = [{ kind: "member", id: "om_it" }, { kind: "team", id: "tem_it" }, { kind: "role", id: "member" }, { kind: "org", id: "org_1" }]
const financeClerk: AccessPrincipal[] = [{ kind: "member", id: "om_fin" }, { kind: "team", id: "tem_finance" }, { kind: "role", id: "member" }, { kind: "org", id: "org_1" }]
const decide = (rules: AccessPolicyRule[], principals: AccessPrincipal[], baseline: AccessBaseline = "open", resourceId = "coder") =>
  decideAccess({ rules, principals, resourceKind: "model", resourceId, baseline, now })

describe("decideAccess", () => {
  test("no rules: the baseline decides", () => {
    assert.deepEqual(decide([], financeClerk, "open"), { allowed: true, via: "open" })
    assert.deepEqual(decide([], financeClerk, "closed"), { allowed: false, via: "default" })
    assert.deepEqual(decide([], financeClerk, "granted"), { allowed: true, via: "grant" })
  })

  test("an allow rule restricts the resource to its grantees", () => {
    const rules = [rule({ principalKind: "team", principalId: "tem_it", effect: "allow" })]
    includes(decide(rules, itEngineer), { allowed: true, via: "policy" })
    assert.deepEqual(decide(rules, financeClerk), { allowed: false, via: "restricted" })
    // Other resources of the kind are not affected.
    assert.deepEqual(decide(rules, financeClerk, "open", "main"), { allowed: true, via: "open" })
    // An explicit grant in the resource's own table still counts.
    assert.deepEqual(decide(rules, financeClerk, "granted"), { allowed: true, via: "grant" })
  })

  test("deny overrides allow and grants", () => {
    const allow = rule({ principalKind: "team", principalId: "tem_it", effect: "allow" })
    const deny = rule({ principalKind: "member", principalId: "om_it", effect: "deny" })
    assert.deepEqual(decide([allow, deny], itEngineer), { allowed: false, via: "policy", ruleId: deny.id })
    includes(decide([allow, deny], itEngineer, "granted"), { allowed: false, via: "policy" })
  })

  test("a wildcard rule covers every resource of the kind", () => {
    const rules = [rule({ resourceId: "*", principalKind: "role", principalId: "member", effect: "deny" })]
    includes(decide(rules, financeClerk, "open", "anything"), { allowed: false, via: "policy" })
  })

  test("rules for another kind do not apply", () => {
    const rules = [rule({ resourceKind: "plugin", principalKind: "org", principalId: "org_1", effect: "deny" })]
    assert.deepEqual(decide(rules, financeClerk), { allowed: true, via: "open" })
  })

  test("expired and removed rules have no effect", () => {
    const rules = [
      rule({ principalKind: "org", principalId: "org_1", effect: "deny", expiresAt: new Date("2026-11-23T00:00:00Z") }),
      rule({ principalKind: "org", principalId: "org_1", effect: "deny", removedAt: new Date("2026-11-01T00:00:00Z") }),
      rule({ principalKind: "team", principalId: "tem_it", effect: "allow", expiresAt: new Date("2026-11-01T00:00:00Z") }),
    ]
    assert.deepEqual(decide(rules, financeClerk), { allowed: true, via: "open" })
  })

  test("a time-bound grant works until it expires", () => {
    const rules = [rule({ principalKind: "member", principalId: "om_fin", effect: "allow", expiresAt: new Date("2026-12-24T00:00:00Z") })]
    includes(decide(rules, financeClerk, "closed"), { allowed: true, via: "policy" })
    assert.deepEqual(decideAccess({ rules, principals: financeClerk, resourceKind: "model", resourceId: "coder", baseline: "closed", now: new Date("2026-12-25T00:00:00Z") }),
      { allowed: false, via: "default" })
  })
})
