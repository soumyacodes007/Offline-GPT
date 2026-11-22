import { execFile } from "node:child_process";

// Mirrors how T3 Code handles Claude sign-in: OfflineGPT never talks to
// claude.ai itself. The user signs in with the official `claude` CLI
// (`claude auth login`) and we only read back its status.

export type ClaudeCliAuthStatus =
  | { state: "not-installed" }
  | { state: "unknown"; detail: string }
  | { state: "signed-out" }
  | {
      state: "signed-in";
      authMethod?: string;
      email?: string;
      subscriptionType?: string;
    };

const STATUS_TIMEOUT_MS = 10_000;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseClaudeAuthStatusOutput(stdout: string): ClaudeCliAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "unknown", detail: "Claude CLI returned an unreadable status." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { state: "unknown", detail: "Claude CLI returned an unreadable status." };
  }
  if (!("loggedIn" in parsed) || parsed.loggedIn !== true) return { state: "signed-out" };
  return {
    state: "signed-in",
    authMethod: "authMethod" in parsed ? readString(parsed.authMethod) : undefined,
    email: "email" in parsed ? readString(parsed.email) : undefined,
    subscriptionType: "subscriptionType" in parsed ? readString(parsed.subscriptionType) : undefined,
  };
}

export function readClaudeCliAuthStatus(binaryPath = "claude"): Promise<ClaudeCliAuthStatus> {
  const realHome = process.env.OFFLINEGPT_REAL_HOME;
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["auth", "status"],
      // npm/winget installs expose claude as a .cmd shim on Windows.
      {
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
        shell: process.platform === "win32",
        // Dev mode sandboxes HOME/USERPROFILE; the CLI's sign-in lives in the real home.
        env: realHome ? { ...process.env, HOME: realHome, USERPROFILE: realHome } : process.env,
      },
      (error, stdout) => {
        if (error) {
          if ("code" in error && error.code === "ENOENT") return resolve({ state: "not-installed" });
          // `claude auth status` exits non-zero when signed out but still prints JSON.
          if (stdout.trim()) return resolve(parseClaudeAuthStatusOutput(stdout));
          // cmd.exe reports a missing binary as exit code 1 with no stdout.
          if (process.platform === "win32" && /not recognized/i.test(error.message)) {
            return resolve({ state: "not-installed" });
          }
          return resolve({ state: "unknown", detail: "Could not run `claude auth status`." });
        }
        resolve(parseClaudeAuthStatusOutput(stdout));
      },
    );
  });
}
