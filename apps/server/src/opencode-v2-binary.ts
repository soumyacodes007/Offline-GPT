import { externalFetch } from "./server-fetch.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };
import { isAirgappedEdition } from "./edition.js";

const exec = promisify(execFile);

// GitHub serves release assets from github.com through a redirect to its asset CDN.
const RELEASE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

async function downloadReleaseAsset(url: string): Promise<Buffer> {
  const assertReleaseHost = (target: URL) => {
    if (target.protocol !== "https:" || !RELEASE_HOSTS.has(target.hostname)) {
      throw new Error(`OpenCode v2 download left the GitHub release hosts (${target.hostname})`);
    }
  };
  assertReleaseHost(new URL(url));
  // Electron's net.fetch rejects redirect: "manual" ("Redirect was cancelled"),
  // so follow redirects and check where they ended. The caller verifies the SHA-256.
  const response = await externalFetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (response.url) assertReleaseHost(new URL(response.url));
  if (!response.ok) throw new Error(`OpenCode v2 download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function findFile(directory: string, name: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

/** Install only the pinned native executable from the verified release archive. */
export async function installOpencodeV2Binary(cacheRoot: string, version: string): Promise<string> {
  if (version !== artifacts.version) throw new Error(`No verified OpenCode v2 artifacts for ${version}`);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const report = process.platform === "linux" ? process.report?.getReport() : undefined;
  const glibc = typeof report === "object" && report !== null && "header" in report
    && typeof report.header === "object" && report.header !== null && "glibcVersionRuntime" in report.header;
  const key = `${platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}${platform === "linux" && !glibc ? "-musl" : ""}`;
  const artifact = Object.entries(artifacts.platforms).find(([name]) => name === key)?.[1];
  if (!artifact) throw new Error(`OpenCode v2 does not support ${key}`);
  const directory = join(cacheRoot, version, key);
  const name = platform === "windows" ? "opencode2.exe" : "opencode2";
  const binary = join(directory, name);
  try { await access(binary); return binary; } catch { /* First installation. */ }
  if (isAirgappedEdition()) {
    throw new Error("OpenCode v2 is not installed and OFFLINEGPT_EDITION=airgapped forbids downloading it. Put opencode2 on PATH or set OFFLINEGPT_OPENCODE2_BIN to the bundled engine.");
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staging = await mkdtemp(join(directory, ".install-"));
  try {
    const bytes = await downloadReleaseAsset(artifact.url);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) throw new Error("OpenCode v2 archive checksum mismatch");
    const archive = join(staging, artifact.url.endsWith(".zip") ? "release.zip" : "release.tar.gz");
    await writeFile(archive, bytes, { mode: 0o600 });
    const extracted = join(staging, "extracted");
    await mkdir(extracted);
    // bsdtar (Windows 10+, macOS) reads zip and tar.gz; Linux assets are tar.gz for GNU tar.
    // On Windows name System32's bsdtar: a GNU tar earlier on PATH (Git for Windows) reads "C:" as a remote host.
    const tar = platform === "windows" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    await exec(tar, ["-xf", archive, "-C", extracted], { timeout: 120_000 });
    const executable = await findFile(extracted, platform === "windows" ? "opencode.exe" : "opencode");
    if (!executable) throw new Error("OpenCode v2 archive did not contain the opencode executable");
    await chmod(executable, 0o755);
    await rename(executable, binary);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
