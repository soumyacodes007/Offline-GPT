import { eq } from "drizzle-orm";
import { customRoles } from "@offlinegpt-platform/db";
import type { Deps } from "./deps";
import type { Member } from "./sessions";

/** Admin areas a custom role can open to a member. See docs/platform-spec/roles.md. */
export const PERMISSIONS = ["people", "access", "requests", "knowledge", "library", "audit", "usage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

function isPermission(value: string): value is Permission {
  return PERMISSIONS.some((permission) => permission === value);
}

/** Owners and admins hold every permission; a member holds their custom role's. */
export async function permissionsOf(deps: Deps, member: Member): Promise<Permission[]> {
  if (member.role !== "member") return [...PERMISSIONS];
  if (!member.customRoleId) return [];
  const [role] = await deps.db.select({ permissions: customRoles.permissions }).from(customRoles).where(eq(customRoles.id, member.customRoleId)).limit(1);
  return (role?.permissions ?? []).filter(isPermission);
}
