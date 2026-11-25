import { and, eq, isNull } from "@offlinegpt-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  ConnectorInstanceTable,
  ExternalMcpConnectionTable,
  KnowledgeDocumentTable,
  LlmProviderTable,
  MarketplaceTable,
  PluginTable,
} from "@offlinegpt-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { listSelfHostedModels } from "../../llm/self-hosted-models.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import type { ENFORCED_ACCESS_POLICY_KINDS } from "./access-policy.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole } from "./shared.js"

type Resource = { kind: (typeof ENFORCED_ACCESS_POLICY_KINDS)[number]; id: string; label: string; detail?: string }

const resourceSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
}).meta({ ref: "AccessResource" })

/**
 * The things access rules and requests can name, by their readable names, so
 * the portal offers a list to pick from instead of asking people for ids.
 * Members see what they could ask for; admins also see knowledge documents,
 * model providers, and each connection's tools.
 */
export function registerOrgAccessResourceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/access-policy/resources",
    describeRoute({
      tags: ["Access Policy"],
      summary: "List resources by name",
      description: "Models, connections, plugins and skills that access rules and requests can name. Admins also get knowledge documents, model providers, marketplaces and connectors.",
      responses: { 200: jsonResponse("Resources.", z.object({ resources: z.array(resourceSchema) })) },
    }),
    orgMemberRoute(),
    async (c) => {
      const organizationId = c.get("organizationContext").organization.id
      const isAdmin = ensureOrganizationAdminRole(c, "").ok
      const [models, connections, plugins, skills] = await Promise.all([
        listSelfHostedModels(),
        db.select({ id: ExternalMcpConnectionTable.id, name: ExternalMcpConnectionTable.name })
          .from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.organizationId, organizationId)),
        db.select({ id: PluginTable.id, name: PluginTable.name, description: PluginTable.description })
          .from(PluginTable).where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.status, "active"), isNull(PluginTable.deletedAt))),
        db.select({ id: ConfigObjectTable.id, title: ConfigObjectTable.title, objectType: ConfigObjectTable.objectType })
          .from(ConfigObjectTable).where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.status, "active"), isNull(ConfigObjectTable.deletedAt))),
      ])
      const resources: Resource[] = [
        ...models.map((model) => ({ kind: "model" as const, id: model.modelId, label: model.name })),
        ...connections.map((connection) => ({ kind: "mcp_connection" as const, id: connection.id, label: connection.name })),
        ...plugins.map((plugin) => ({ kind: "plugin" as const, id: plugin.id, label: plugin.name, ...(plugin.description ? { detail: plugin.description } : {}) })),
        ...skills.map((skill) => ({ kind: "config_object" as const, id: skill.id, label: skill.title, detail: skill.objectType })),
      ]
      if (!isAdmin) return c.json({ resources })

      const [documents, providers, marketplaces, connectors] = await Promise.all([
        db.select({ id: KnowledgeDocumentTable.id, title: KnowledgeDocumentTable.title })
          .from(KnowledgeDocumentTable).where(and(eq(KnowledgeDocumentTable.organizationId, organizationId), isNull(KnowledgeDocumentTable.removedAt))),
        db.select({ id: LlmProviderTable.id, name: LlmProviderTable.name })
          .from(LlmProviderTable).where(eq(LlmProviderTable.organizationId, organizationId)),
        db.select({ id: MarketplaceTable.id, name: MarketplaceTable.name })
          .from(MarketplaceTable).where(and(eq(MarketplaceTable.organizationId, organizationId), eq(MarketplaceTable.status, "active"), isNull(MarketplaceTable.deletedAt))),
        db.select({ id: ConnectorInstanceTable.id, name: ConnectorInstanceTable.name })
          .from(ConnectorInstanceTable).where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.status, "active"))),
      ])
      return c.json({
        resources: [
          ...resources,
          ...connections.map((connection) => ({ kind: "capability" as const, id: `mcp:${connection.id}:*`, label: `${connection.name} (all tools)` })),
          ...documents.map((doc) => ({ kind: "knowledge_document" as const, id: doc.id, label: doc.title })),
          ...providers.map((provider) => ({ kind: "llm_provider" as const, id: provider.id, label: provider.name })),
          ...marketplaces.map((marketplace) => ({ kind: "marketplace" as const, id: marketplace.id, label: marketplace.name })),
          ...connectors.map((connector) => ({ kind: "connector_instance" as const, id: connector.id, label: connector.name })),
        ],
      })
    },
  )
}
