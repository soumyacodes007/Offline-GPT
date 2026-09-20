import { execSync } from "node:child_process";

execSync("pnpm --filter @offlinegpt/desktop build", { stdio: "inherit" });
