import { openDatabase } from "@offlinegpt-platform/db";
import { createGateway } from "./app";
import { parseGatewayConfig } from "./config";

const config = parseGatewayConfig(process.env);
const database = openDatabase(config.databaseUrl);
// The control service owns migrations; the gateway only reads and appends usage.
const app = createGateway({ db: database.db, models: config.models, dailyTokenLimit: config.dailyTokenLimit, now: () => new Date(), fetch });
const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 255 });
console.log(JSON.stringify({ level: "info", service: "model-gateway", message: "listening", port: server.port, models: config.models.map((model) => model.alias) }));

async function shutdown() {
  await server.stop();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
