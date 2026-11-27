import { bigserial, boolean, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
});

export const schema = { members, teams, teamMembers, sessions, accessRules, auditEvents, settings };
