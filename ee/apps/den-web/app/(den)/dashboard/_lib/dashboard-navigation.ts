import {
  AppWindow,
  BarChart3,
  BookLock,
  KeyRound,
  Box,
  Globe,
  Home,
  LayoutDashboard,
  LibraryBig,
  Plug,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  type DenOrgAccessFlags,
  type DenOrgCapabilities,
  getAccessRoute,
  getAnalyticsRoute,
  getApiKeysRoute,
  getBillingRoute,
  getBrandAppearanceRoute,
  getCustomLlmProvidersRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getInferenceRoute,
  getKnowledgeRoute,
  getLibraryRoute,
  getManagedDashboardsRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getMyAccessRoute,
  getOrgDashboardRoute,
  getOrgSettingsRoute,
  getPluginsRoute,
  getScimRoute,
  getSsoRoute,
  getToolTesterRoute,
  getWebRoute,
} from "../../_lib/den-org";
import type { DenOrgMode } from "../../_lib/runtime-config";

export type DashboardNavChild = {
  href: string;
  label: string;
  badge?: string;
};

export type DashboardNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  testId?: string;
  /** Extra pathname prefixes that select this entry. */
  matchHrefs?: string[];
  /** Grouped entries link to the first child and expand on child pages. */
  children?: DashboardNavChild[];
};

export type DashboardNavSection = {
  label: string;
  items: DashboardNavItem[];
};

export type DashboardSearchItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  section: string;
  keywords: string[];
};

export type BuildDashboardNavSectionsInput = {
  orgSlug: string | null;
  access: DenOrgAccessFlags;
  capabilities: DenOrgCapabilities;
  orgMode: DenOrgMode;
  runtimeConfigLoaded: boolean;
  airgapped?: boolean;
  /** The employee app's URL, linked from the air-gapped nav. */
  appUrl?: string;
};

export function buildDashboardNavSections({
  orgSlug,
  access,
  capabilities,
  orgMode,
  runtimeConfigLoaded,
  airgapped = false,
  appUrl,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  if (airgapped) return buildAirgappedNavSections({ orgSlug, access, capabilities, appUrl });
  const showWeb = runtimeConfigLoaded && capabilities.offlinegptWeb;
  const workItems: DashboardNavItem[] = [
    {
      href: orgSlug ? getOrgDashboardRoute(orgSlug) : "#",
      label: "Dashboard",
      icon: Home,
    },
    {
      href: orgSlug ? getLibraryRoute(orgSlug) : "#",
      label: "My Library",
      icon: LibraryBig,
    },
    {
      href: orgSlug ? getMyAccessRoute(orgSlug) : "#",
      label: "Knowledge & access",
      icon: BookLock,
    },
    ...(showWeb
      ? [{ href: orgSlug ? getWebRoute(orgSlug) : "#", label: "OfflineGPT Web", icon: Globe }]
      : []),
  ];

  // Hosted deployments expose OfflineGPT Models, and so does the air-gapped
  // edition, where they are the customer's own self-hosted models. Other
  // self-hosted deployments only expose their own providers. Keep hidden until
  // runtime config is known.
  const showOfflineGPTModels = runtimeConfigLoaded && (orgMode === "multi_org" || airgapped);
  const modelsGroup: DashboardNavItem | null = access.isAdmin && orgSlug
    ? {
        href: showOfflineGPTModels
          ? getInferenceRoute(orgSlug)
          : getCustomLlmProvidersRoute(orgSlug),
        label: "Models",
        icon: Sparkles,
        badge: "Providers",
        children: [
          ...(showOfflineGPTModels
            ? [{ href: getInferenceRoute(orgSlug), label: "OfflineGPT Models" }]
            : []),
          { href: getCustomLlmProvidersRoute(orgSlug), label: "Bring your Own Keys" },
        ],
      }
    : null;
  const manageItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        { href: getPluginsRoute(orgSlug), label: "Plugin Directory", icon: Box },
        {
          href: getMcpConnectionsRoute(orgSlug),
          label: "Connectors",
          icon: Plug,
          badge: "MCPs",
        },
        ...(capabilities.mcpConnections && access.isAdmin
          ? [{ href: getToolTesterRoute(orgSlug), label: "Tool Tester", icon: Wrench }]
          : []),
        ...(capabilities.orgManagedDashboards
          ? [{ href: getManagedDashboardsRoute(orgSlug), label: "Dashboards", icon: LayoutDashboard }]
          : []),
        ...(modelsGroup ? [modelsGroup] : []),
        {
          href: getMarketplacesRoute(orgSlug),
          label: "Advanced",
          icon: Settings2,
          matchHrefs: [
            getDesktopPoliciesRoute(orgSlug),
            getBrandAppearanceRoute(orgSlug),
          ],
        },
      ]
    : [];
  const observabilityItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        { href: getAnalyticsRoute(orgSlug), label: "Analytics", icon: BarChart3 },
      ]
    : [];
  const settingsChildren: DashboardNavChild[] = orgSlug
    ? [
        ...(access.canViewSettings
          ? [
              { href: getOrgSettingsRoute(orgSlug), label: "General" },
              { href: getDiagnosticsRoute(orgSlug), label: "Diagnostics" },
              { href: getBillingRoute(orgSlug), label: "Billing" },
              { href: getApiKeysRoute(orgSlug), label: "API Keys" },
              { href: getSsoRoute(orgSlug), label: "SSO" },
              { href: getScimRoute(orgSlug), label: "SCIM" },
            ]
          : []),
      ]
    : [];
  const settingsGroup: DashboardNavItem | null = settingsChildren.length > 0
    ? {
        href: settingsChildren[0].href,
        label: "Settings",
        icon: SlidersHorizontal,
        children: settingsChildren,
      }
    : null;
  const teamItems: DashboardNavItem[] = [
    ...(access.isAdmin && orgSlug
      ? [
          { href: getMembersRoute(orgSlug), label: "Members", icon: Users },
          { href: getAccessRoute(orgSlug), label: "Access", icon: KeyRound },
          { href: getKnowledgeRoute(orgSlug), label: "Knowledge", icon: BookLock },
        ]
      : []),
    ...(settingsGroup ? [settingsGroup] : []),
  ];

  return [
    { label: "Work", items: workItems },
    ...(manageItems.length > 0 ? [{ label: "Manage", items: manageItems }] : []),
    ...(observabilityItems.length > 0 ? [{ label: "Observability", items: observabilityItems }] : []),
    ...(teamItems.length > 0 ? [{ label: "Team", items: teamItems }] : []),
  ];
}

/**
 * The air-gapped edition's nav: what an employee needs (the app, their
 * library, their access), then what an admin runs (people, access,
 * knowledge, models, tools). Hosted-only pages (billing, OfflineGPT Web,
 * bring-your-own-keys, diagnostics upload, usage analytics) are left out
 * because they need the public internet or do not apply.
 */
function buildAirgappedNavSections({ orgSlug, access, capabilities, appUrl }: {
  orgSlug: string | null;
  access: DenOrgAccessFlags;
  capabilities: DenOrgCapabilities;
  appUrl?: string;
}): DashboardNavSection[] {
  if (!orgSlug) return [];
  const work: DashboardNavItem[] = [
    { href: getOrgDashboardRoute(orgSlug), label: "Home", icon: Home },
    ...(appUrl ? [{ href: appUrl, label: "Open OfflineGPT", icon: AppWindow }] : []),
    { href: getLibraryRoute(orgSlug), label: "My library", icon: LibraryBig },
    { href: getMyAccessRoute(orgSlug), label: "My access", icon: KeyRound },
  ];
  if (!access.isAdmin) return [{ label: "Work", items: work }];

  const admin: DashboardNavItem[] = [
    { href: getMembersRoute(orgSlug), label: "People", icon: Users },
    { href: getAccessRoute(orgSlug), label: "Access", icon: ShieldCheck },
    { href: getKnowledgeRoute(orgSlug), label: "Knowledge", icon: BookLock },
    { href: getInferenceRoute(orgSlug), label: "Models", icon: Sparkles },
    { href: getMcpConnectionsRoute(orgSlug), label: "Connectors", icon: Plug },
    { href: getPluginsRoute(orgSlug), label: "Plugins", icon: Box },
    ...(capabilities.mcpConnections ? [{ href: getToolTesterRoute(orgSlug), label: "Tool Tester", icon: Wrench }] : []),
  ];
  const settingsChildren: DashboardNavChild[] = access.canViewSettings
    ? [
        { href: getOrgSettingsRoute(orgSlug), label: "General" },
        { href: getSsoRoute(orgSlug), label: "SSO" },
        { href: getScimRoute(orgSlug), label: "SCIM" },
        { href: getApiKeysRoute(orgSlug), label: "API Keys" },
        { href: getMarketplacesRoute(orgSlug), label: "Advanced" },
      ]
    : [];
  return [
    { label: "Work", items: work },
    {
      label: "Admin",
      items: [
        ...admin,
        ...(settingsChildren.length > 0
          ? [{ href: settingsChildren[0].href, label: "Settings", icon: SlidersHorizontal, children: settingsChildren, matchHrefs: [getDesktopPoliciesRoute(orgSlug), getBrandAppearanceRoute(orgSlug)] }]
          : []),
      ],
    },
  ];
}

// Alias order is ranking priority in the command palette.
const PAGE_KEYWORDS: Record<string, string[]> = {
  Access: ["permissions", "rules", "requests", "approve", "deny", "knowledge", "policy"],
  "Knowledge & access": ["knowledge base", "documents", "request access", "search"],
  Home: ["dashboard", "overview"],
  Knowledge: ["knowledge base", "documents", "policies", "upload", "sensitive", "restricted"],
  "My access": ["request access", "permissions", "knowledge", "search", "my requests"],
  "My library": ["skills", "plugins", "connections"],
  "Open OfflineGPT": ["app", "chat", "workspace"],
  People: ["members", "users", "invite", "teams", "roles"],
  Plugins: ["skills", "plugins", "marketplace"],
  Advanced: ["policy", "desktop policies", "mdm", "lock", "marketplace", "branding"],
  Analytics: ["usage", "stats", "consumption", "history", "langfuse"],
  "API Keys": ["token", "secret"],
  Billing: ["plan", "invoice", "payment"],
  "Bring your Own Keys": ["llm", "provider", "byok", "api key"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  Dashboard: ["home", "overview"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "debug", "troubleshooting"],
  General: ["organization", "workspace"],
  Members: ["people", "users", "invite", "teams", "roles"],
  Models: ["llm", "provider", "byok", "api key"],
  "My Library": ["skills", "plugins", "connections"],
  "OfflineGPT Models": ["llm", "provider", "managed", "inference"],
  "OfflineGPT Web": ["cloud", "sessions"],
  "Plugin Directory": ["skills", "plugins", "marketplace"],
  SCIM: ["provisioning", "directory", "users"],
  Settings: ["organization", "workspace"],
  SSO: ["single sign on", "saml", "oidc"],
  "Tool Tester": ["tools", "test", "mcp"],
};

function keywordsFor(...labels: string[]): string[] {
  return [...new Set(labels.flatMap((label) => PAGE_KEYWORDS[label] ?? []))];
}

export function flattenNavigationForSearch(sections: DashboardNavSection[]): DashboardSearchItem[] {
  return sections.flatMap((section) => section.items.flatMap((item) => {
    if (item.children) {
      return item.children.map((child) => ({
        id: `page:${section.label}:${item.label}:${child.label}`,
        label: `${item.label} › ${child.label}`,
        href: child.href,
        icon: item.icon,
        section: section.label,
        keywords: keywordsFor(item.label, child.label),
      }));
    }

    return [{
      id: `page:${section.label}:${item.label}`,
      label: item.label,
      href: item.href,
      icon: item.icon,
      section: section.label,
      keywords: keywordsFor(item.label),
    }];
  }));
}
