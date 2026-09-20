import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const sourceDir = path.join(appDir, "src", "models")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devOfflineGptApi = "http://127.0.0.1:8791/api/v1"
const prodOfflineGptApi = "https://inference.offlinegptlabs.com/api/v1"

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function offlinegptProvider(models, api) {
  return {
    offlinegpt: {
      id: "offlinegpt",
      env: ["OFFLINEGPT_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "OfflineGPT Models",
      api,
      models,
    },
  }
}

const isDevMode = process.env.OFFLINEGPT_DEV_MODE === "1"
const base = await readJson(path.join(sourceDir, "base.json"))
const offlinegptModels = await readJson(path.join(sourceDir, "offlinegpt-models.json"))
const offlinegpt = offlinegptProvider(offlinegptModels, isDevMode ? devOfflineGptApi : prodOfflineGptApi)
const models = { ...base, ...offlinegpt }

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[inference] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
