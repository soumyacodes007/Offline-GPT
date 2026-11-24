"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getRequestError, requestJson } from "../../_lib/den-flow";

export const accessResourceKinds = [
  "model",
  "llm_provider",
  "plugin",
  "marketplace",
  "config_object",
  "connector_instance",
  "mcp_connection",
  "capability",
  "knowledge_document",
  "knowledge_chunk",
] as const;
export type AccessResourceKind = (typeof accessResourceKinds)[number];

export const accessResourceKindLabels: Record<AccessResourceKind, { label: string; noun: string; hint: string; verb: string }> = {
  model: { label: "Model", noun: "model", hint: "Model alias, e.g. main or coder", verb: "use" },
  llm_provider: { label: "Model provider", noun: "provider", hint: "Provider id (llp_…)", verb: "use" },
  plugin: { label: "Plugin", noun: "plugin", hint: "Plugin id", verb: "use" },
  marketplace: { label: "Marketplace", noun: "marketplace", hint: "Marketplace id", verb: "use" },
  config_object: { label: "Skill or command", noun: "skill", hint: "Skill, command or agent id", verb: "use" },
  connector_instance: { label: "Connector", noun: "connector", hint: "Connector instance id", verb: "use" },
  mcp_connection: { label: "MCP connection", noun: "connection", hint: "Connection id", verb: "use" },
  capability: { label: "Tool action", noun: "action", hint: "Capability name, or a prefix ending in * (mcp:<connection>:*)", verb: "run" },
  knowledge_document: { label: "Knowledge document", noun: "document", hint: "Document id", verb: "read" },
  knowledge_chunk: { label: "Knowledge section", noun: "section", hint: "Section id", verb: "read" },
};

export const principalKinds = ["member", "team", "role", "org"] as const;
export type PrincipalKind = (typeof principalKinds)[number];
export type Principal = { principalKind: PrincipalKind; principalId: string };

const ruleSchema = z.object({
  id: z.string(),
  resourceKind: z.enum(accessResourceKinds),
  resourceId: z.string(),
  principalKind: z.enum(principalKinds),
  principalId: z.string(),
  effect: z.enum(["allow", "deny"]),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  reason: z.string().nullable(),
  createdByOrgMembershipId: z.string(),
  createdAt: z.string(),
});
export type AccessRule = z.infer<typeof ruleSchema>;

export const accessRequestStatuses = ["pending", "approved", "declined", "cancelled", "expired"] as const;
const requestSchema = z.object({
  id: z.string(),
  requesterOrgMembershipId: z.string(),
  resourceKind: z.enum(accessResourceKinds),
  resourceId: z.string(),
  resourceLabel: z.string().nullable(),
  purpose: z.string(),
  requestedDays: z.number().nullable(),
  status: z.enum(accessRequestStatuses),
  expiresAt: z.string(),
  decidedByOrgMembershipId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  grantedRuleId: z.string().nullable(),
  createdAt: z.string(),
});
export type AccessRequest = z.infer<typeof requestSchema>;

const decisionSchema = z.object({
  decision: z.object({ allowed: z.boolean(), via: z.string(), ruleId: z.string().optional() }),
  principals: z.array(z.object({ kind: z.enum(principalKinds), id: z.string() })),
});
export type AccessCheck = z.infer<typeof decisionSchema>;

export const sensitivities = ["ordinary", "sensitive", "restricted"] as const;
export type Sensitivity = (typeof sensitivities)[number];
const docRuleSchema = z.object({
  id: z.string(),
  principalKind: z.enum(principalKinds),
  principalId: z.string(),
  effect: z.enum(["allow", "deny"]),
  expiresAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type DocumentRule = z.infer<typeof docRuleSchema>;
const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceName: z.string().nullable(),
  mimeType: z.string(),
  createdAt: z.string(),
  chunkCount: z.number(),
  sensitivity: z.record(z.enum(sensitivities), z.number()).optional(),
  chunksWithRules: z.number().optional(),
  audience: z.array(docRuleSchema).optional(),
});
export type KnowledgeDocument = z.infer<typeof documentSchema>;
const chunkSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  heading: z.string().nullable(),
  text: z.string(),
  sensitivity: z.enum(sensitivities),
  rules: z.array(docRuleSchema).optional(),
});
export type KnowledgeChunk = z.infer<typeof chunkSchema>;
const documentDetailSchema = z.object({
  document: z.object({ id: z.string(), title: z.string(), sourceName: z.string().nullable(), createdAt: z.string(), audience: z.array(docRuleSchema).optional() }),
  chunks: z.array(chunkSchema),
  hiddenCount: z.number(),
});
export type KnowledgeDocumentDetail = z.infer<typeof documentDetailSchema>;
const searchResultSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  heading: z.string().nullable(),
  text: z.string(),
  sensitivity: z.enum(sensitivities),
});
export type KnowledgeSearchResult = z.infer<typeof searchResultSchema>;

async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit, fallback: string): Promise<T> {
  const { response, payload } = await requestJson(path, init, 15000);
  if (!response.ok) throw getRequestError(payload, response, fallback);
  return schema.parse(payload);
}

async function send(path: string, init: RequestInit, fallback: string) {
  const { response, payload } = await requestJson(path, init, 15000);
  if (!response.ok) throw getRequestError(payload, response, fallback);
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const accessKeys = {
  rules: (orgId: string | null) => ["access", orgId, "rules"] as const,
  requests: (orgId: string | null, scope: "mine" | "all") => ["access", orgId, "requests", scope] as const,
  documents: (orgId: string | null) => ["access", orgId, "knowledge"] as const,
  document: (orgId: string | null, id: string) => ["access", orgId, "knowledge", id] as const,
};

export function useAccessRules(orgId: string | null) {
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: accessKeys.rules(orgId),
    queryFn: () => call("/v1/access-policy/rules", z.object({ rules: z.array(ruleSchema) }), { method: "GET" }, "Could not load access rules.").then((r) => r.rules),
  });
}

export function useAccessRequests(orgId: string | null, scope: "mine" | "all") {
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: accessKeys.requests(orgId, scope),
    queryFn: () => call(`/v1/access-requests?scope=${scope}`, z.object({ requests: z.array(requestSchema) }), { method: "GET" }, "Could not load access requests.").then((r) => r.requests),
    refetchInterval: 30000,
  });
}

export function useKnowledgeDocuments(orgId: string | null) {
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: accessKeys.documents(orgId),
    queryFn: () => call("/v1/knowledge/documents", z.object({ documents: z.array(documentSchema) }), { method: "GET" }, "Could not load the knowledge base.").then((r) => r.documents),
  });
}

export function useKnowledgeDocument(orgId: string | null, documentId: string | null) {
  return useQuery({
    enabled: Boolean(orgId && documentId),
    queryKey: accessKeys.document(orgId, documentId ?? ""),
    queryFn: () => call(`/v1/knowledge/documents/${encodeURIComponent(documentId ?? "")}`, documentDetailSchema, { method: "GET" }, "Could not open the document."),
  });
}

export function useInvalidateAccess(orgId: string | null) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["access", orgId] });
}

export type RuleInput = Principal & {
  resourceKind: AccessResourceKind;
  resourceId: string;
  effect: "allow" | "deny";
  expiresAt?: string;
  reason?: string;
};

export const createRule = (input: RuleInput) => send("/v1/access-policy/rules", json("POST", input), "Could not save the rule.");
export const removeRule = (ruleId: string) => send(`/v1/access-policy/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }, "Could not remove the rule.");
export const checkAccess = (input: { memberId: string; resourceKind: AccessResourceKind; resourceId: string }) =>
  call("/v1/access-policy/check", decisionSchema, json("POST", input), "Could not check access.");

export const createAccessRequest = (input: { resourceKind: AccessResourceKind; resourceId: string; resourceLabel?: string; purpose: string; requestedDays: number | null }) =>
  send("/v1/access-requests", json("POST", input), "Could not send the request.");
export const approveAccessRequest = (id: string, input: { durationDays: number | null; note?: string }) =>
  send(`/v1/access-requests/${encodeURIComponent(id)}/approve`, json("POST", input), "Could not approve the request.");
export const declineAccessRequest = (id: string, note?: string) =>
  send(`/v1/access-requests/${encodeURIComponent(id)}/decline`, json("POST", note ? { note } : {}), "Could not decline the request.");
export const cancelAccessRequest = (id: string) => send(`/v1/access-requests/${encodeURIComponent(id)}/cancel`, { method: "POST" }, "Could not cancel the request.");

export const createKnowledgeDocument = (input: { title: string; text: string; sourceName?: string; audience: Principal[]; sensitivity: Sensitivity }) =>
  send("/v1/knowledge/documents", json("POST", input), "Could not add the document.");
export const removeKnowledgeDocument = (id: string) => send(`/v1/knowledge/documents/${encodeURIComponent(id)}`, { method: "DELETE" }, "Could not remove the document.");
export const labelKnowledgeChunk = (id: string, sensitivity: Sensitivity) =>
  send(`/v1/knowledge/chunks/${encodeURIComponent(id)}`, json("PATCH", { sensitivity }), "Could not change the label.");
export const searchKnowledge = (query: string) =>
  call("/v1/knowledge/search", z.object({ results: z.array(searchResultSchema) }), json("POST", { query, limit: 10 }), "Search failed.").then((r) => r.results);

export const durationChoices = [
  { value: "1", label: "1 day", days: 1 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "forever", label: "Until removed", days: null },
] as const;

export function durationLabel(days: number | null) {
  return durationChoices.find((choice) => choice.days === days)?.label ?? `${days} days`;
}

export function relativeTime(iso: string, now = Date.now()) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return "just now";
}
