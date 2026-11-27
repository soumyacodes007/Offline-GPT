import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { schema } from "./schema";

export * from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseHandle = {
  db: Database;
  /** Apply every pending migration. Safe to call on each start. */
  migrate: () => Promise<void>;
  close: () => Promise<void>;
};

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Connect to a real Postgres server, e.g. `postgres://user:pass@db:5432/offlinegpt`. */
export function connectPostgres(url: string): DatabaseHandle {
  const client = postgres(url, { max: 10 });
  const db = drizzlePostgres(client, { schema });
  return {
    db,
    migrate: () => migratePostgres(db, { migrationsFolder }),
    close: () => client.end(),
  };
}

/**
 * An in-process Postgres (PGlite). `dataDir` keeps data on disk; omit it for a
 * throwaway in-memory database, as tests do.
 */
export function openEmbeddedPostgres(dataDir?: string): DatabaseHandle {
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  return {
    db,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}

/** Pick the driver from a URL: `postgres://` or `postgresql://` for a server, `pglite:<dir>` or `pglite:memory` for embedded. */
export function openDatabase(url: string): DatabaseHandle {
  if (url.startsWith("pglite:")) {
    const location = url.slice("pglite:".length);
    return openEmbeddedPostgres(location === "memory" ? undefined : location);
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return connectPostgres(url);
  throw new Error("DATABASE_URL must start with postgres://, postgresql:// or pglite:");
}
