/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const POLL_INTERVAL_MS = 3000;

// Same idea as T3 Code's onboarding: type the official CLI command into an
// in-app terminal and re-check the sign-in until it succeeds.
export function claudeTerminalCommand(kind: "login" | "install", platform: "darwin" | "linux" | "windows" | undefined): string {
  if (kind === "login") return "claude auth login";
  if (platform === "windows") return 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"';
  return "curl -fsSL https://claude.ai/install.sh | bash";
}

export function isClaudeTerminalAvailable(): boolean {
  const bridge = window.__OFFLINEGPT_ELECTRON__?.terminal;
  return Boolean(bridge?.create && bridge.write && bridge.resize && bridge.kill && bridge.onData && bridge.onExit);
}

type ClaudeLoginTerminalProps = {
  command: string;
  /** Resolves true once Claude is signed in. Polled while the terminal is open. */
  checkSignedIn: () => Promise<boolean>;
  onSignedIn: () => void;
  onClose: () => void;
};

export function ClaudeLoginTerminal({ command, checkSignedIn, onSignedIn, onClose }: ClaudeLoginTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const checkRef = useRef(checkSignedIn);
  const signedInRef = useRef(onSignedIn);
  checkRef.current = checkSignedIn;
  signedInRef.current = onSignedIn;
  const [status, setStatus] = useState("Starting terminal…");

  useEffect(() => {
    const bridge = window.__OFFLINEGPT_ELECTRON__?.terminal;
    if (!containerRef.current || !bridge?.create || !bridge.write || !bridge.resize || !bridge.kill || !bridge.onData || !bridge.onExit) {
      setStatus("Terminal is unavailable.");
      return;
    }
    const { create, write, resize, kill, onData, onExit } = bridge;

    let disposed = false;
    let terminalId: string | null = null;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', Menlo, monospace",
      fontSize: 12,
      theme: { background: "#0b0d12", foreground: "#d7dde8", cursor: "#ffffff", selectionBackground: "#334155" },
    });
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    const removeData = onData((payload) => {
      if (payload.terminalId === terminalId) terminal.write(payload.data);
    });
    const removeExit = onExit((payload) => {
      if (payload.terminalId !== terminalId) return;
      terminalId = null;
      setStatus("Terminal closed.");
    });
    const input = terminal.onData((data) => {
      if (terminalId) void write(terminalId, data);
    });
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (terminalId) void resize(terminalId, terminal.cols, terminal.rows);
    });
    observer.observe(containerRef.current);

    // Empty cwd makes the desktop app start the shell in the user's home folder.
    void create({ cwd: "", cols: terminal.cols, rows: terminal.rows })
      .then(async ({ terminalId: id }) => {
        if (disposed) {
          void kill(id);
          return;
        }
        terminalId = id;
        await write(id, `${command}\r`);
        terminal.focus();
        setStatus("Finish signing in in your browser. This closes when you're signed in.");
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Could not start terminal.");
      });

    const poll = window.setInterval(() => {
      void checkRef.current().then((signedIn) => {
        if (signedIn && !disposed) signedInRef.current();
      });
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      observer.disconnect();
      input.dispose();
      removeData();
      removeExit();
      if (terminalId) void kill(terminalId);
      terminal.dispose();
    };
  }, [command]);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-6/50 bg-[#0b0d12] text-white">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/35 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate text-white/75">{status}</span>
        <button type="button" className="text-white/70 hover:text-white" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div ref={containerRef} className="h-48 px-2 py-1 [&_.xterm]:h-full" />
    </div>
  );
}
