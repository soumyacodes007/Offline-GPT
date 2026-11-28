import { openDatabase } from "@offlinegpt-platform/db";
import { createApp } from "./app";
import { createWorkspaceOrigin } from "./routes/workspaces";
import { parseConfig } from "./config";
import { audit } from "./audit";
import { createSyslogSender, parseSyslogTarget } from "./syslog";
import { createDocker, dockerTransport } from "./workspaces/docker";
import { createWorkspaceService } from "./workspaces/service";

const config = parseConfig(process.env);
const database = openDatabase(config.databaseUrl);
await database.migrate();

const now = () => new Date();
const workspaces = config.workspaces ? createWorkspaceService(database.db, createDocker(dockerTransport(config.workspaces.dockerUrl)), config.workspaces, now, fetch) : null;
const syslog = config.auditSyslog
  ? createSyslogSender(parseSyslogTarget(config.auditSyslog), (error) => console.error(JSON.stringify({ level: "error", service: "control", message: "audit syslog send failed", error: error.message })))
  : null;
const deps = { db: database.db, config, now, fetch, workspaces, ...(syslog ? { auditSink: syslog.send } : {}) };
const app = createApp(deps);
const idleTimer = workspaces
  ? setInterval(() => {
      workspaces.stopIdle().catch((error: unknown) => console.error(JSON.stringify({ level: "error", service: "control", message: "idle stop failed", error: String(error) })));
      const retentionMs = config.workspaces?.retentionMs;
      if (retentionMs) {
        workspaces.purgeLeavers(retentionMs)
          .then((purged) => Promise.all(purged.map((leaver) => audit(deps, "system", "workspace.purged", { memberId: leaver.memberId, reason: "leaver retention ended" }))))
          .catch((error: unknown) => console.error(JSON.stringify({ level: "error", service: "control", message: "leaver purge failed", error: String(error) })));
      }
    }, 5 * 60 * 1000)
  : null;
const checkpointMs = config.workspaces?.checkpointMs;
const checkpointTimer = workspaces && checkpointMs
  ? setInterval(() => {
      const kept = config.workspaces?.checkpointsKept ?? 7;
      workspaces.checkpointAll(kept)
        .then((failed) => (failed ? console.error(JSON.stringify({ level: "error", service: "control", message: "some workspace checkpoints failed", failed })) : undefined))
        .catch((error: unknown) => console.error(JSON.stringify({ level: "error", service: "control", message: "checkpoints failed", error: String(error) })));
    }, checkpointMs)
  : null;
const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch });
const origin = workspaces ? Bun.serve({ port: config.workspaceOriginPort, hostname: "0.0.0.0", fetch: createWorkspaceOrigin(deps, workspaces).fetch, idleTimeout: 255 }) : null;
console.log(JSON.stringify({ level: "info", service: "control", message: "listening", port: server.port, workspacePort: origin?.port ?? null }));

async function shutdown() {
  if (idleTimer) clearInterval(idleTimer);
  if (checkpointTimer) clearInterval(checkpointTimer);
  await server.stop();
  await origin?.stop();
  syslog?.close();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
