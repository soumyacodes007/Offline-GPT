/** Who a rule is about. */
export type Principal =
  | { type: "member"; memberId: string }
  | { type: "team"; teamId: string }
  | { type: "role"; role: string }
  | { type: "everyone" };

export type Effect = "allow" | "deny";

/** What happens to a resource of a kind when no allow rule names it. */
export type Baseline = "open" | "closed";

/** A parsed rule target: one exact id, or every id starting with `prefix`. */
export type Target = { type: "exact"; id: string } | { type: "prefix"; prefix: string };

export type Rule = {
  id: string;
  kind: string;
  target: Target;
  principal: Principal;
  effect: Effect;
  /** The rule stops applying at this instant. `null` means it never expires. */
  expiresAt: Date | null;
  reason: string;
};

export type Subject = {
  memberId: string;
  teamIds: ReadonlySet<string>;
  roles: ReadonlySet<string>;
};

export type Resource = { kind: string; id: string };

export type Cause =
  | { type: "deny-rule"; rule: Rule }
  | { type: "allow-rule"; rule: Rule }
  | { type: "restricted" }
  | { type: "baseline"; baseline: Baseline };

export type Decision = { allowed: boolean; cause: Cause };
