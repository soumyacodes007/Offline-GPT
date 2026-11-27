# Platform spec: access policy

Phase 0 behaviour spec for `platform/packages/policy`. It describes what the
access decision must do. It is not an implementation guide.

## Terms

- **Resource**: a thing a member can use, named by a *kind* and an *id*.
  Kinds: `model`, `capability`, `plugin`, `skill`, `mcp-connection`,
  `knowledge-document`, `knowledge-section`, `workspace-setting`. The set is
  open: a new kind needs no change to the decision rules.
- **Subject**: the member asking. A subject has a member id, the ids of the
  teams it belongs to, and its role names.
- **Principal**: who a rule is about. One of: a member, a team, a role, or
  everyone.
- **Rule**: kind, target, principal, effect (`allow` or `deny`), optional
  expiry time, and a reason written by a person.
- **Target**: either an exact resource id, or a prefix pattern ending in a
  single `*` (`docs/hr/*`). `*` alone matches every id of that kind. A `*`
  anywhere but the end is invalid.
- **Baseline**: what happens to a resource of a kind when no allow rule names
  it. `open` means everyone may use it; `closed` means nobody may.

## Decision

Given a subject, a resource, the rules and the kind's baseline, at time *now*:

1. Ignore rules for other kinds, rules whose target does not match the
   resource id, and rules whose expiry is at or before *now*.
2. Of the rules left, a rule **applies** to the subject when its principal is
   the subject's member, one of its teams, one of its roles, or everyone.
3. If any applying rule is a **deny**, the answer is **denied**. A deny always
   wins, whatever allows exist.
4. Otherwise, if any rule left after step 1 is an **allow** (for anyone), the
   resource is **restricted**: the answer is **allowed** only when an applying
   allow exists, and **denied** otherwise.
5. Otherwise the baseline decides.

The decision always carries its **cause**, so an admin can see why:

- the deny rule that won;
- the allow rule that granted access;
- "restricted to others" (allow rules exist, none applies to this subject);
- the baseline that applied.

When several rules could be the cause, the most specific one is reported: an
exact target beats a pattern, a longer pattern beats a shorter one, and a
member principal beats a team, then a role, then everyone. If they are still
tied, the earliest expiry is reported (a rule that never expires counts as
last), then the lowest rule id.

## Properties the implementation must have

- **Pure**: no clock, database or network access; *now* is an input.
- **Fresh**: callers decide at the moment of use. Nothing is cached between
  rule changes.
- **Total**: every input gives a decision; there are no exceptions for valid
  input. Invalid targets are rejected when a rule is *created*, not at
  decision time.
- **Batch-friendly**: deciding many resources for one subject takes linear
  time in rules plus resources, so list endpoints can filter large catalogues.

## Journey proof (once HTTP exists)

`evals/specs/platform-access-policy.test.ts` must show, through the control
API:

- a team allow restricts a model to that team; another member is refused;
- a member deny beats a team allow;
- an expired allow stops working without anyone touching it;
- a `docs/hr/*` deny hides every HR document but not `docs/hr-policy`;
- "check access" returns the cause above for each case.
