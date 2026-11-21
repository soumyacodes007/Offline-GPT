// Cua Driver integration (https://github.com/trycua/cua, libs/cua-driver).
// OfflineGPT does not bundle a computer-use runtime: it locates the user's
// installed `cua-driver`, launches it as a stdio MCP server, and reports its
// own status/doctor output. Cua Driver owns OS permissions and input safety.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EXECUTABLE = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
const CHECK_TIMEOUT_MS = 10_000;
const DOCTOR_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64_000;

/** Install commands published by Cua; shown verbatim in Settings. */
export const CUA_DRIVER_INSTALL_COMMAND = process.platform === "win32"
  ? "irm https://cua.ai/driver/install.ps1 | iex"
  : '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"';

function candidatePaths() {
  const home = os.homedir();
  const fromEnv = [process.env.OFFLINEGPT_CUA_DRIVER_PATH, process.env.CUA_DRIVER_PATH]
    .map((value) => value?.trim())
    .filter(Boolean);
  const installDir = process.env.CUA_DRIVER_RS_INSTALL_DIR?.trim();
  // Electron GUI apps do not inherit the login shell PATH on macOS, so check
  // the installer's documented locations before PATH.
  const known = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "Cua", "cua-driver", "bin", EXECUTABLE)]
    : process.platform === "darwin"
      ? ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", path.join(home, ".local", "bin", EXECUTABLE), "/opt/homebrew/bin/cua-driver", "/usr/local/bin/cua-driver"]
      : [path.join(home, ".local", "bin", EXECUTABLE), "/usr/local/bin/cua-driver", "/usr/bin/cua-driver"];
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, EXECUTABLE));
  return [...fromEnv, ...(installDir ? [path.join(installDir, EXECUTABLE)] : []), ...known, ...onPath];
}

export function resolveCuaDriverExecutable() {
  return candidatePaths().find((candidate) => existsSync(candidate)) ?? null;
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk) => { if (output.length < OUTPUT_LIMIT) output += chunk; };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ code: -1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, output: output.trim() }));
  });
}

function requireExecutable() {
  const executable = resolveCuaDriverExecutable();
  if (!executable) throw new Error(`Cua Driver is not installed. Install it with: ${CUA_DRIVER_INSTALL_COMMAND}`);
  return executable;
}

/** stdio MCP command for the workspace's `cua-driver` server. */
export async function getCuaDriverMcpCommand() {
  return [requireExecutable(), "mcp"];
}

/** Installation, version and service status. Never throws. */
export async function checkCuaDriver() {
  const executable = resolveCuaDriverExecutable();
  if (!executable) return { installed: false, platform: process.platform, installCommand: CUA_DRIVER_INSTALL_COMMAND };
  const [version, status, permissions] = await Promise.all([
    run(executable, ["--version"], CHECK_TIMEOUT_MS),
    run(executable, ["status"], CHECK_TIMEOUT_MS),
    process.platform === "darwin" ? run(executable, ["permissions", "status"], CHECK_TIMEOUT_MS) : Promise.resolve(null),
  ]);
  return {
    installed: true,
    platform: process.platform,
    path: executable,
    // `--version` prints "cua-driver 0.55.0"; keep just the version.
    version: version.code === 0 ? version.output.split(/\r?\n/, 1)[0].replace(/^cua-driver\s+/i, "") : null,
    status: status.output,
    statusOk: status.code === 0,
    ...(permissions ? { permissions: permissions.output, permissionsOk: permissions.code === 0 } : {}),
    installCommand: CUA_DRIVER_INSTALL_COMMAND,
  };
}

/** `cua-driver doctor`: the driver's own end-to-end diagnosis. */
export async function runCuaDriverDoctor() {
  const result = await run(requireExecutable(), ["doctor"], DOCTOR_TIMEOUT_MS);
  return { ok: result.code === 0, output: result.output };
}

/** Run Cua's official installer. Only called from an explicit Settings click. */
export async function installCuaDriver() {
  const result = process.platform === "win32"
    ? await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CUA_DRIVER_INSTALL_COMMAND], INSTALL_TIMEOUT_MS)
    : await run("/bin/bash", ["-c", 'script="$(curl -fsSL https://cua.ai/driver/install.sh)" && /bin/bash -c "$script"'], INSTALL_TIMEOUT_MS);
  return { ok: result.code === 0 && resolveCuaDriverExecutable() !== null, output: result.output };
}

/**
 * Run `work(tool)` against a short-lived `cua-driver mcp` stdio session.
 * Bare MCP owns its runtime on Windows/Linux and proxies the signed service on
 * macOS, so this works without a separately started daemon (CLI
 * `cua-driver call` requires one). `tool` resolves to structuredContent.
 */
async function withCuaDriverMcp(executable, work, timeoutMs = CHECK_TIMEOUT_MS) {
  const child = spawn(executable, ["mcp"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const waiters = new Map();
  let buffer = "";
  let nextId = 0;
  let failure = null;
  const failAll = (error) => {
    failure ??= error;
    for (const { reject } of waiters.values()) reject(failure);
    waiters.clear();
  };
  child.on("error", failAll);
  child.on("exit", () => failAll(new Error("cua-driver mcp exited")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = waiters.get(message.id);
      if (!waiter) continue;
      waiters.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "cua-driver MCP request failed"));
      else waiter.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    waiters.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const timer = setTimeout(() => failAll(new Error("cua-driver mcp timed out")), timeoutMs);
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "offlinegpt", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tool = async (name, args) => {
      const result = await request("tools/call", { name, arguments: args });
      if (result?.isError) {
        const text = result.content?.find((part) => part.type === "text")?.text;
        throw new Error(text ? `cua-driver ${name}: ${text.slice(0, 300)}` : `cua-driver ${name} failed`);
      }
      return result?.structuredContent;
    };
    return await work(tool);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** Running apps for composer @App mentions, via Cua Driver's `list_apps`. Never throws. */
export async function listRunningApps() {
  const executable = resolveCuaDriverExecutable();
  if (!executable) return { ok: false, apps: [] };
  try {
    const result = await withCuaDriverMcp(executable, (tool) => tool("list_apps", {}));
    const entries = Array.isArray(result?.apps) ? result.apps : [];
    const names = new Set();
    for (const entry of entries) {
      if (!entry || entry.running !== true || typeof entry.name !== "string") continue;
      const name = entry.name.trim().replace(/\.exe$/i, "");
      if (name && name.toLowerCase() !== "cua-driver") names.add(name);
    }
    return { ok: true, apps: [...names].sort((left, right) => left.localeCompare(right)) };
  } catch {
    return { ok: false, apps: [] };
  }
}

// ---------------------------------------------------------------------------
// Agent cursor: Cua Driver's on-screen overlay that shows where the agent acts.
// Defaults are persistent `cua-driver config` keys applied to new sessions.
// ---------------------------------------------------------------------------

/** Editable cursor keys and their allowed values (`cua-driver config set --help`). */
const CURSOR_SETTING_VALUES = {
  "agent_cursor.enabled": ["true", "false"],
  "cursor.motion.style": ["signature_arc", "spring_settle", "magnetic", "comet_swoop", "adaptive", "classic"],
  "cursor.motion.timing": ["default", "native", "fitts", "fixed"],
  "cursor.motion.effects.trail": ["on", "off"],
  "cursor.motion.effects.glow": ["on", "off"],
  "cursor.halo": ["on", "off"],
  "cursor.float": ["on", "off"],
  "cursor.rotate": ["heading", "lean", "off"],
  "cursor.badges": ["minimal", "verbose", "off"],
};

function parseConfigJson(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error(output || "cua-driver config returned no data");
  return JSON.parse(output.slice(start));
}

function cursorSettingsFromConfig(config) {
  const cursor = config?.cursor ?? {};
  const motion = cursor.motion ?? {};
  const effects = motion.effects ?? {};
  return {
    enabled: config?.agent_cursor?.enabled !== false,
    style: typeof motion.style === "string" ? motion.style : "signature_arc",
    // `steady` is the built-in default timing; it is not a settable value.
    timing: typeof motion.timing === "string" && motion.timing !== "steady" ? motion.timing : "default",
    trail: effects.trail === true,
    glow: effects.glow === true,
    halo: cursor.halo !== false,
    float: cursor.float !== false,
    rotate: typeof cursor.rotate === "string" ? cursor.rotate : "heading",
    badges: typeof cursor.badges === "string" ? cursor.badges : "minimal",
  };
}

/** Current agent cursor defaults from `cua-driver config show`. */
export async function getCuaCursorSettings() {
  const result = await run(requireExecutable(), ["config", "show"], CHECK_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(result.output || "cua-driver config show failed");
  return cursorSettingsFromConfig(parseConfigJson(result.output));
}

/** Persist one allow-listed cursor default; returns the updated settings. */
export async function setCuaCursorSetting(key, value) {
  const allowed = Object.hasOwn(CURSOR_SETTING_VALUES, key) ? CURSOR_SETTING_VALUES[key] : null;
  if (!allowed || typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Unsupported cursor setting: ${String(key)}=${String(value)}`);
  }
  const result = await run(requireExecutable(), ["config", "set", key, value], CHECK_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(result.output || `cua-driver config set ${key} failed`);
  return cursorSettingsFromConfig(parseConfigJson(result.output));
}

const PREVIEW_SESSION = "offlinegpt-cursor-preview";
const PREVIEW_STEP_MS = 750;

/**
 * Glide the agent cursor overlay through a loop around the center of `area`
 * (screen coordinates). Window scope moves only the overlay, never the real
 * pointer. Uses the saved defaults, so the preview reflects the settings.
 */
export async function previewCuaCursor(area) {
  const width = Math.max(200, area.width);
  const height = Math.max(200, area.height);
  const cx = area.x + width / 2;
  const cy = area.y + height / 2;
  const dx = Math.min(240, width / 4);
  const dy = Math.min(140, height / 4);
  const points = [[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx, cy]];
  return withCuaDriverMcp(requireExecutable(), async (tool) => {
    await tool("start_session", { session: PREVIEW_SESSION });
    try {
      await tool("set_agent_cursor_enabled", { session: PREVIEW_SESSION, enabled: true });
      for (const [x, y] of points) {
        await tool("move_cursor", { session: PREVIEW_SESSION, x: Math.round(x), y: Math.round(y) });
        await new Promise((resolve) => setTimeout(resolve, PREVIEW_STEP_MS));
      }
      // Leave it on screen briefly so the resting float and halo are visible.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { ok: true };
    } finally {
      await tool("end_session", { session: PREVIEW_SESSION }).catch(() => undefined);
    }
  }, 30_000);
}
