// Finishes the OpenCode v2 plugin folders after `bun build` writes each
// `<plugin>/server.js`. v2 loads a configured local plugin only from a folder,
// so each one gets a package.json, plus the PDFium wasm its PDF tools load.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outRoot = resolve(process.argv[2] ?? "dist/opencode-plugins-v2");
const plugins = [
  { name: "offlinegpt-office", pdfium: true },
  { name: "offlinegpt-tools", pdfium: false },
  { name: "offlinegpt-schedule", pdfium: false },
  { name: "offlinegpt-lean-context", pdfium: false },
  { name: "managed-policy", pdfium: false },
];

for (const plugin of plugins) {
  const outdir = join(outRoot, plugin.name);
  writeFileSync(join(outdir, "package.json"), `${JSON.stringify({ name: plugin.name, private: true, type: "module" }, null, 2)}\n`);
  if (plugin.pdfium) execFileSync(process.execPath, ["scripts/copy-pdfium-wasm.mjs", outdir], { stdio: "inherit" });
}
