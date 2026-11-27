import { openDatabase } from "@offlinegpt-platform/db";
import { createApp } from "./app";
import { createWorkspaceOrigin } from "./routes/workspaces";
import { parseConfig } from "./config";
import { createDocker, dockerTransport } from "./workspaces/docker";
import { createWorkspaceService } from "./workspaces/service";

const config = parseConfig(process.env);
const database = openDatabase(config.databaseUrl);
await database.migrate();

const now = () => new Date();
const workspaces = config.workspaces ? createWorkspaceService(database.db, createDocker(dockerTransport(config.workspaces.dockerUrl)), config.workspaces, now, fetch) : null;
const app = createApp({ db: database.db, config, now, fetch, workspaces });
const idleTimer = workspaces
  ? setInterval(() => {
      workspaces.stopIdle().catch((error: unknown) => console.error(JSON.stringify({ level: "error", service: "control", message: "idle stop failed", error: String(error) })));
    }, 5 * 60 * 1000)
  : null;
const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch });
const deps = { db: database.db, config, now, fetch, workspaces };
const origin = workspaces ? Bun.serve({ port: config.workspaceOriginPort, hostname: "0.0.0.0", fetch: createWorkspaceOrigin(deps, workspaces).fetch, idleTimeout: 255 }) : null;
console.log(JSON.stringify({ level: "info", service: "control", message: "listening", port: server.port, workspacePort: origin?.port ?? null }));

async function shutdown() {
  if (idleTimer) clearInterval(idleTimer);
  await server.stop();
  await origin?.stop();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
