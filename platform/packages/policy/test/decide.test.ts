import { describe, expect, test } from "bun:test";
import { decide, decideMany, parseTarget, type Principal, type Rule, type Subject, type Target } from "../src";

const now = new Date("2026-12-01T12:00:00Z");
const alice: Subject = { memberId: "m-alice", teamIds: new Set(["t-legal"]), roles: new Set(["member"]) };
const bob: Subject = { memberId: "m-bob", teamIds: new Set(["t-sales"]), roles: new Set(["member"]) };

function target(raw: string): Target {
  const parsed = parseTarget(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.target;
}

let nextId = 0;
function rule(effect: Rule["effect"], raw: string, principal: Principal, extra: Partial<Rule> = {}): Rule {
  nextId += 1;
  return { id: `r${String(nextId).padStart(3, "0")}`, kind: "model", target: target(raw), principal, effect, expiresAt: null, reason: "test", ...extra };
}

const model = (id: string) => ({ kind: "model", id });

describe("targets", () => {
  test("accept exact ids and trailing-star patterns only", () => {
    expect(parseTarget("qwen-7b")).toEqual({ ok: true, target: { type: "exact", id: "qwen-7b" } });
    expect(parseTarget("docs/hr/*")).toEqual({ ok: true, target: { type: "prefix", prefix: "docs/hr/" } });
    expect(parseTarget("*")).toEqual({ ok: true, target: { type: "prefix", prefix: "" } });
    expect(parseTarget("docs/*/hr").ok).toBe(false);
    expect(parseTarget("a**").ok).toBe(false);
    expect(parseTarget("  ").ok).toBe(false);
  });
});

describe("decide", () => {
  test("with no rules the baseline decides", () => {
    expect(decide({ subject: alice, resource: model("qwen"), rules: [], baseline: "open", now })).toEqual({ allowed: true, cause: { type: "baseline", baseline: "open" } });
    expect(decide({ subject: alice, resource: model("qwen"), rules: [], baseline: "closed", now }).allowed).toBe(false);
  });

  test("a team allow restricts the resource to that team", () => {
    const rules = [rule("allow", "qwen", { type: "team", teamId: "t-legal" })];
    expect(decide({ subject: alice, resource: model("qwen"), rules, baseline: "open", now }).allowed).toBe(true);
    expect(decide({ subject: bob, resource: model("qwen"), rules, baseline: "open", now })).toEqual({ allowed: false, cause: { type: "restricted" } });
  });

  test("an allow on a closed kind opens the resource for its grantees", () => {
    const rules = [rule("allow", "qwen", { type: "role", role: "member" })];
    expect(decide({ subject: bob, resource: model("qwen"), rules, baseline: "closed", now }).allowed).toBe(true);
  });

  test("a member deny beats a team allow", () => {
    const deny = rule("deny", "qwen", { type: "member", memberId: "m-alice" });
    const rules = [rule("allow", "qwen", { type: "team", teamId: "t-legal" }), deny];
    expect(decide({ subject: alice, resource: model("qwen"), rules, baseline: "open", now })).toEqual({ allowed: false, cause: { type: "deny-rule", rule: deny } });
  });

  test("an expired rule stops applying on its own", () => {
    const rules = [rule("allow", "qwen", { type: "member", memberId: "m-alice" }, { expiresAt: new Date("2026-12-01T11:59:59Z") })];
    expect(decide({ subject: alice, resource: model("qwen"), rules, baseline: "closed", now }).allowed).toBe(false);
    // Expiry exactly at now has already ended.
    const atNow = [rule("allow", "qwen", { type: "member", memberId: "m-alice" }, { expiresAt: now })];
    expect(decide({ subject: alice, resource: model("qwen"), rules: atNow, baseline: "closed", now }).allowed).toBe(false);
  });

  test("a prefix deny hides matching ids but not ids that only share letters", () => {
    const rules = [rule("deny", "docs/hr/*", { type: "everyone" }, { kind: "knowledge-document" })];
    const doc = (id: string) => ({ kind: "knowledge-document", id });
    expect(decide({ subject: alice, resource: doc("docs/hr/salaries"), rules, baseline: "open", now }).allowed).toBe(false);
    expect(decide({ subject: alice, resource: doc("docs/hr-policy"), rules, baseline: "open", now }).allowed).toBe(true);
  });

  test("rules of another kind never apply", () => {
    const rules = [rule("deny", "qwen", { type: "everyone" }, { kind: "plugin" })];
    expect(decide({ subject: alice, resource: model("qwen"), rules, baseline: "open", now }).allowed).toBe(true);
  });

  test("the reported cause is the most specific rule", () => {
    const broad = rule("allow", "*", { type: "everyone" });
    const narrow = rule("allow", "qw*", { type: "everyone" });
    const exactTeam = rule("allow", "qwen", { type: "team", teamId: "t-legal" });
    const exactMember = rule("allow", "qwen", { type: "member", memberId: "m-alice" });
    const decision = decide({ subject: alice, resource: model("qwen"), rules: [broad, narrow, exactTeam, exactMember], baseline: "closed", now });
    expect(decision.cause).toEqual({ type: "allow-rule", rule: exactMember });
    const withoutExact = decide({ subject: alice, resource: model("qwen"), rules: [broad, narrow], baseline: "closed", now });
    expect(withoutExact.cause).toEqual({ type: "allow-rule", rule: narrow });
  });

  test("ties report the earliest expiry, then the lowest id", () => {
    const later = rule("allow", "qwen", { type: "everyone" }, { id: "a", expiresAt: new Date("2027-01-01T00:00:00Z") });
    const sooner = rule("allow", "qwen", { type: "everyone" }, { id: "b", expiresAt: new Date("2026-12-10T00:00:00Z") });
    const forever = rule("allow", "qwen", { type: "everyone" }, { id: "0" });
    expect(decide({ subject: alice, resource: model("qwen"), rules: [forever, later, sooner], baseline: "closed", now }).cause).toEqual({ type: "allow-rule", rule: sooner });
    const twinA = rule("allow", "qwen", { type: "everyone" }, { id: "x2" });
    const twinB = rule("allow", "qwen", { type: "everyone" }, { id: "x1" });
    expect(decide({ subject: alice, resource: model("qwen"), rules: [twinA, twinB], baseline: "closed", now }).cause).toEqual({ type: "allow-rule", rule: twinB });
  });
});

describe("decideMany", () => {
  test("filters a catalogue in one pass and matches single decisions", () => {
    const rules = [
      rule("allow", "private/*", { type: "team", teamId: "t-legal" }),
      rule("deny", "private/secret", { type: "member", memberId: "m-alice" }),
    ];
    const ids = ["public", "private/a", "private/secret"];
    const many = decideMany({ subject: alice, kind: "model", ids, rules, baseline: "open", now });
    expect([...many].map(([id, decision]) => [id, decision.allowed])).toEqual([["public", true], ["private/a", true], ["private/secret", false]]);
    for (const id of ids) expect(many.get(id)).toEqual(decide({ subject: alice, resource: model(id), rules, baseline: "open", now }));
  });
});
