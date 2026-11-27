import type { Database } from "@offlinegpt-platform/db";
import type { Config } from "./config";

/** Everything a route needs from the outside world, so tests can replace it. */
export type Deps = {
  db: Database;
  config: Config;
  now: () => Date;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};
