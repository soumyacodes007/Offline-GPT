import { eq } from "drizzle-orm";
import { settings, type Database } from "@offlinegpt-platform/db";
import { z } from "zod";

/**
 * What members may do inside their workspace, enforced by the workspace
 * server (the same controls a Den organization sets for desktops).
 */
export const workspacePolicySchema = z.object({
  /** `deny` turns off running shell commands entirely. */
  commands: z.enum(["allow", "deny"]),
  /** Command patterns that are never allowed, e.g. `curl *`. */
  blockedCommands: z.array(z.string().trim().min(1).max(500)).max(100),
  /** When set, the browser may only open these origins; web fetch and search are off. */
  browserOrigins: z.array(
    z.url({ protocol: /^https?$/ }).max(2048)
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
      }, "Give a site without a path, e.g. https://intranet.example.gov")
      .transform((value) => new URL(value).origin),
  ).max(100).nullable(),
  blockBrowserUploads: z.boolean(),
});
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;

/** Nothing restricted until an admin says otherwise. */
export const OPEN_POLICY: WorkspacePolicy = { commands: "allow", blockedCommands: [], browserOrigins: null, blockBrowserUploads: false };

const KEY = "workspace.policy";

export async function readWorkspacePolicy(db: Database): Promise<WorkspacePolicy> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1);
  const parsed = workspacePolicySchema.safeParse(row?.value);
  return parsed.success ? parsed.data : OPEN_POLICY;
}

export async function writeWorkspacePolicy(db: Database, policy: WorkspacePolicy): Promise<void> {
  await db.insert(settings).values({ key: KEY, value: policy }).onConflictDoUpdate({ target: settings.key, set: { value: policy } });
}

/** The managed-policy document the workspace server accepts, or null to clear it. */
export function managedPolicyOf(policy: WorkspacePolicy) {
  const open = policy.commands === "allow" && !policy.blockedCommands.length && policy.browserOrigins === null && !policy.blockBrowserUploads;
  if (open) return null;
  return {
    execution: {
      commands: policy.commands,
      blockedCommands: policy.blockedCommands,
      ...(policy.browserOrigins ? { browserOrigins: policy.browserOrigins } : {}),
      blockBrowserUploads: policy.blockBrowserUploads,
    },
  };
}
