import { index, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Access policy rules, modelled on qm's ACL grants. A rule says that a
 * principal (one member, a team — including teams synced from SCIM/AD groups —
 * every member with a Den role, or the whole org) is allowed or denied one
 * resource, or every resource of a kind (`resource_id = "*"`).
 *
 * Rules sit on top of the resource-specific grant tables: deny always wins,
 * an allow rule grants access the existing grants do not, and a rule past its
 * `expires_at` or with `removed_at` set has no effect.
 */
export const accessPolicyResourceKindValues = [
  "model",
  "plugin",
  "marketplace",
  "config_object",
  "connector_instance",
  "mcp_connection",
  "llm_provider",
  "capability",
] as const

export const accessPolicyPrincipalKindValues = ["member", "team", "role", "org"] as const
export const accessPolicyEffectValues = ["allow", "deny"] as const

export const AccessPolicyRuleTable = mysqlTable(
  "access_policy_rule",
  {
    id: denTypeIdColumn("accessPolicyRule", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    resourceKind: mysqlEnum("resource_kind", accessPolicyResourceKindValues).notNull(),
    resourceId: varchar("resource_id", { length: 191 }).notNull(),
    principalKind: mysqlEnum("principal_kind", accessPolicyPrincipalKindValues).notNull(),
    principalId: varchar("principal_id", { length: 191 }).notNull(),
    effect: mysqlEnum("effect", accessPolicyEffectValues).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    reason: varchar("reason", { length: 1000 }),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
    removedByOrgMembershipId: denTypeIdColumn("member", "removed_by_org_membership_id"),
  },
  (table) => [
    index("access_policy_rule_org_resource").on(table.organizationId, table.resourceKind, table.resourceId),
    index("access_policy_rule_org_principal").on(table.organizationId, table.principalKind, table.principalId),
  ],
)

export const accessPolicyRule = AccessPolicyRuleTable
