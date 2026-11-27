import { eq } from "drizzle-orm";
import { settings } from "@offlinegpt-platform/db";
import { z } from "zod";
import type { Deps } from "./deps";

const SCIM_TOKEN_KEY = "scim.token_hash";
const tokenHashSchema = z.string().length(64);

export async function readScimTokenHash(deps: Deps): Promise<string | null> {
  const [row] = await deps.db.select().from(settings).where(eq(settings.key, SCIM_TOKEN_KEY)).limit(1);
  const parsed = tokenHashSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function writeScimTokenHash(deps: Deps, hash: string): Promise<void> {
  await deps.db.insert(settings).values({ key: SCIM_TOKEN_KEY, value: hash }).onConflictDoUpdate({ target: settings.key, set: { value: hash } });
}
