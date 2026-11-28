import { z } from "zod";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const errorSchema = z.object({ message: z.string() });

/** Call the control API on the same origin; the session cookie authenticates. */
export async function api<S extends z.ZodType>(schema: S, path: string, init: { method?: string; body?: unknown } = {}): Promise<z.infer<S>> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const parsed = errorSchema.safeParse(data);
    throw new ApiError(response.status, parsed.success ? parsed.data.message : `Request failed (${response.status}).`);
  }
  return schema.parse(data);
}

export const empty = z.unknown();

export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof meSchema>;

export const KINDS = ["model", "knowledge-document", "knowledge-section", "plugin", "skill", "mcp-connection", "capability", "workspace-setting"] as const;

export const ruleSchema = z.object({
  id: z.string(),
  kind: z.string(),
  target: z.string(),
  effect: z.enum(["allow", "deny"]),
  principalType: z.enum(["member", "team", "role", "everyone"]),
  principalRef: z.string().nullable(),
  expiresAt: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
});
export type AccessRule = z.infer<typeof ruleSchema>;

export const requestSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  kind: z.string(),
  target: z.string(),
  purpose: z.string(),
  durationDays: z.number().nullable(),
  status: z.enum(["pending", "approved", "declined", "cancelled", "expired"]),
  createdAt: z.string(),
  note: z.string().nullable(),
});
export type AccessRequest = z.infer<typeof requestSchema>;

export const memberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  active: z.boolean(),
  fromDirectory: z.boolean(),
  teamIds: z.array(z.string()),
  customRoleId: z.string().nullable(),
});
export type MemberRow = z.infer<typeof memberSchema>;

export const teamSchema = z.object({ id: z.string(), name: z.string(), source: z.enum(["directory", "manual"]), members: z.number() });

export const documentSchema = z.object({ id: z.string(), path: z.string(), title: z.string(), sections: z.number(), createdAt: z.string() });
export const sectionSchema = z.object({ id: z.string(), position: z.number(), heading: z.string(), body: z.string(), sensitivity: z.enum(["ordinary", "sensitive", "restricted"]), resourceId: z.string() });
export const hitSchema = z.object({ path: z.string(), title: z.string(), section: z.string(), heading: z.string(), text: z.string(), sensitivity: z.string() });

export const decisionSchema = z.object({
  allowed: z.boolean(),
  cause: z.object({ type: z.string(), reason: z.string().optional(), target: z.string().optional(), baseline: z.string().optional() }),
});

export const usageSchema = z.object({ memberId: z.string(), email: z.string(), model: z.string(), calls: z.number(), failed: z.number(), promptTokens: z.number(), completionTokens: z.number() });
export const auditSchema = z.object({ id: z.number(), at: z.string(), actor: z.string(), action: z.string(), details: z.record(z.string(), z.unknown()) });

export function describeCause(cause: z.infer<typeof decisionSchema>["cause"]): string {
  switch (cause.type) {
    case "deny-rule":
      return `Blocked by a rule on ${cause.target ?? "it"}: ${cause.reason ?? ""}`;
    case "allow-rule":
      return `Allowed by a rule on ${cause.target ?? "it"}: ${cause.reason ?? ""}`;
    case "restricted":
      return "Only the people its rules name can use it.";
    case "baseline":
      return cause.baseline === "open" ? "Open to everyone; no rule restricts it." : "Closed until a rule allows it.";
    case "inactive-member":
      return "This person is deactivated.";
    default:
      return cause.type;
  }
}
