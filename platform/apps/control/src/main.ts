import { openDatabase } from "@offlinegpt-platform/db";
import { createApp } from "./app";
import { parseConfig } from "./config";

const config = parseConfig(process.env);
const database = openDatabase(config.databaseUrl);
await database.migrate();

const app = createApp({ db: database.db, config, now: () => new Date(), fetch });
const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch });
console.log(JSON.stringify({ level: "info", service: "control", message: "listening", port: server.port }));

async function shutdown() {
  await server.stop();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
