#!/usr/bin/env node
// Builds the OfflineGPT air-gapped bundle on a machine WITH internet access.
// Carry the output directory into the isolated network, then run its
// install.sh there. Nothing in the bundle downloads anything at runtime.
//
//   node scripts/airgap-bundle.mjs --out ./offlinegpt-airgapped [--models /path/to/Qwen2.5-0.5B-Instruct] [--skip-build]
//
// Output:
//   images/*.tar               docker save of every image the stack runs
//   docker-compose.airgapped.yml
//   models/<name>/             optional model weights for vLLM
//   SHA256SUMS                 checksums of every file above
//   install.sh                 verifies checksums, docker load, prints next steps
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const out = resolve(option("--out") ?? "offlinegpt-airgapped")
const models = option("--models")
const skipBuild = args.includes("--skip-build")
const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))

const built = [
  { tag: "offlinegpt-den-api:airgapped", dockerfile: "packaging/docker/Dockerfile.den" },
  { tag: "offlinegpt-den-web:airgapped", dockerfile: "packaging/docker/Dockerfile.den-web" },
  { tag: "offlinegpt-den-gateway:airgapped", dockerfile: "packaging/docker/Dockerfile.den-gateway" },
  { tag: "offlinegpt-inference:airgapped", dockerfile: "packaging/docker/Dockerfile.inference" },
  { tag: "offlinegpt-workspace:airgapped", dockerfile: "packaging/docker/Dockerfile.workspace-airgapped" },
]
const pulled = ["mysql:8.4", "redis:7.4-alpine", process.env.OFFLINEGPT_VLLM_IMAGE ?? "vllm/vllm-openai:v0.11.0"]

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`)
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs[0]} failed with exit code ${result.status}`)
}

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256")
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex"))).on("error", reject)
  })
}

function files(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

mkdirSync(join(out, "images"), { recursive: true })
for (const image of built) {
  if (!skipBuild) run("docker", ["build", "-f", image.dockerfile, "-t", image.tag, "."])
}
for (const image of pulled) run("docker", ["pull", image])
for (const image of [...built.map((entry) => entry.tag), ...pulled]) {
  run("docker", ["save", "-o", join(out, "images", `${image.replace(/[/:]/g, "_")}.tar`), image])
}

cpSync(join(root, "packaging/docker/docker-compose.airgapped.yml"), join(out, "docker-compose.airgapped.yml"))
if (models) {
  if (!existsSync(models)) throw new Error(`--models path does not exist: ${models}`)
  cpSync(models, join(out, "models", basename(models)), { recursive: true })
}

writeFileSync(join(out, "install.sh"), `#!/bin/sh
# Run inside the isolated network, from this directory.
set -eu
sha256sum -c SHA256SUMS
for image in images/*.tar; do docker load -i "$image"; done
echo
echo "Images loaded. Next:"
echo "  1. Create .env with OFFLINEGPT_MYSQL_PASSWORD, OFFLINEGPT_AUTH_SECRET, OFFLINEGPT_DB_ENCRYPTION_KEY,"
echo "     OFFLINEGPT_GATEWAY_KEY, OFFLINEGPT_ADMIN_BOOTSTRAP_CODE and OFFLINEGPT_PUBLIC_URL."
echo "  2. OFFLINEGPT_MODELS_DIR=\\$PWD/models docker compose -f docker-compose.airgapped.yml up -d"
echo "  3. Open OFFLINEGPT_PUBLIC_URL/setup and enter the bootstrap code."
`, { mode: 0o755 })

const sums = []
for (const file of files(out)) {
  if (basename(file) === "SHA256SUMS" || basename(file) === "install.sh") continue
  sums.push(`${await sha256(file)}  ${relative(out, file).replace(/\\/g, "/")}`)
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`)
console.log(`\nBundle ready: ${out} (${sums.length} files). Copy it into the isolated network and run ./install.sh there.`)
