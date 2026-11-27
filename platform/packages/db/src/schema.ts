import { sql } from "drizzle-orm";
import { bigserial, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  /** Stored lowercased; the sign-in identity across OIDC, SAML and SCIM. */
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** The IdP's stable id for this person (SCIM externalId or OIDC `sub`). */
  externalId: text("external_id").unique(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  active: boolean("active").notNull().default(true),
  /** Only for the local break-glass owner; IdP users never have one. */
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  externalId: text("external_id").unique(),
  createdAt: createdAt(),
});

export const teamMembers = pgTable("team_members", {
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.teamId, table.memberId] }), index("team_members_member_idx").on(table.memberId)]);

export const sessions = pgTable("sessions", {
  /** SHA-256 of the bearer token; the token itself is never stored. */
  tokenHash: text("token_hash").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("sessions_member_idx").on(table.memberId)]);

export const accessRules = pgTable("access_rules", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  /** As written by the admin: an exact id or a `prefix*` pattern. */
  target: text("target").notNull(),
  effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
  principalType: text("principal_type", { enum: ["member", "team", "role", "everyone"] }).notNull(),
  /** Member id, team id or role name; null for everyone. */
  principalRef: text("principal_ref"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (table) => [index("access_rules_kind_idx").on(table.kind)]);

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  /** Member id, `scim`, or `system`. */
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [index("audit_events_at_idx").on(table.at)]);

export const accessRequests = pgTable("access_requests", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  purpose: text("purpose").notNull(),
  /** How long approved access lasts; null means until someone removes the rule. */
  durationDays: integer("duration_days"),
  status: text("status", { enum: ["pending", "approved", "declined", "cancelled"] }).notNull().default("pending"),
  createdAt: createdAt(),
  /** A pending request stops being decidable at this instant. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
  ruleId: text("rule_id"),
}, (table) => [index("access_requests_member_idx").on(table.memberId), index("access_requests_status_idx").on(table.status)]);

export const inferenceKeys = pgTable("inference_keys", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  /** SHA-256 of the key; the key is shown to the member once. */
  keyHash: text("key_hash").notNull().unique(),
  /** The first characters, so people can tell keys apart. */
  prefix: text("prefix").notNull(),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [index("inference_keys_member_idx").on(table.memberId)]);

export const usageRecords = pgTable("usage_records", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  status: text("status", { enum: ["completed", "failed"] }).notNull(),
}, (table) => [index("usage_records_member_at_idx").on(table.memberId, table.at)]);

export const workspaces = pgTable("workspaces", {
  memberId: text("member_id").primaryKey().references(() => members.id, { onDelete: "cascade" }),
  /** Docker container name; also its hostname on the internal network. */
  containerName: text("container_name").notNull().unique(),
  /** Bearer token the router presents to the container. Never sent to the browser. */
  token: text("token").notNull(),
  status: text("status", { enum: ["running", "stopped"] }).notNull(),
  createdAt: createdAt(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
});

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: text("id").primaryKey(),
  /** The policy resource id, e.g. `policies/hr/leave`. */
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const knowledgeSections = pgTable("knowledge_sections", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  /** 1-based; the section's policy id is `<path>#<position>`. */
  position: integer("position").notNull(),
  heading: text("heading").notNull(),
  body: text("body").notNull(),
  sensitivity: text("sensitivity", { enum: ["ordinary", "sensitive", "restricted"] }).notNull().default("ordinary"),
  search: tsvector("search").notNull().generatedAlwaysAs(sql`to_tsvector('simple', heading || ' ' || body)`),
}, (table) => [
  index("knowledge_sections_document_idx").on(table.documentId),
  index("knowledge_sections_search_idx").using("gin", table.search),
]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
});

export const schema = { members, teams, teamMembers, sessions, accessRules, auditEvents, accessRequests, inferenceKeys, usageRecords, workspaces, knowledgeDocuments, knowledgeSections, settings };
