/** @jsxImportSource react */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AppWindow, CheckCircle2, CircleAlert, Download, Globe, Loader2, MousePointerClick, RefreshCw, ShieldCheck, Stethoscope } from "lucide-react";

import { desktopBridge } from "@/app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CuaCursorSettingsSection } from "./cua-cursor-settings";
import { registerExtensionConfig } from "./extension-registry";

type CuaComputerUseConfigProps = {
  connected: boolean;
  connecting: boolean;
  onConnect?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
};

registerExtensionConfig("offlinegpt.computerUse.settings", (ctx) => (
  <CuaComputerUseConfig
    connected={ctx.computerUse?.connected ?? false}
    connecting={ctx.computerUse?.connecting ?? false}
    onConnect={ctx.computerUse?.onConnect}
    onRefresh={ctx.computerUse?.onRefresh}
  />
));

const CHECK_QUERY_KEY = ["computer-use", "cua-driver"];

const capabilities = [
  { icon: AppWindow, name: "Read a window", description: "Targeted accessibility-tree reads and window screenshots of the app you name." },
  { icon: MousePointerClick, name: "Act on controls", description: "Clicks, typing and menus through element tokens, in the background where the app allows it." },
  { icon: Globe, name: "Browser pages", description: "Typed browser actions on supported pages, when the task permits them." },
];

function hasDesktopBridge() {
  return typeof window !== "undefined" && Boolean(window.__OFFLINEGPT_ELECTRON__?.invokeDesktop);
}

export function CuaComputerUseConfig({ connected, connecting, onConnect, onRefresh }: CuaComputerUseConfigProps) {
  const { data: check, isFetching, error: checkError, refetch } = useQuery({
    queryKey: CHECK_QUERY_KEY,
    queryFn: async () => {
      const [result] = await Promise.all([desktopBridge.checkCuaDriver(), onRefresh?.()]);
      return result;
    },
    enabled: hasDesktopBridge(),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const install = useMutation({
    mutationFn: () => desktopBridge.installCuaDriver(),
    onSettled: () => void refetch(),
  });
  const doctor = useMutation({ mutationFn: () => desktopBridge.runCuaDriverDoctor() });
  const connect = useMutation({
    mutationFn: async () => { await onConnect?.(); await onRefresh?.(); },
  });

  const supported = hasDesktopBridge();
  const installed = check?.installed === true;
  const ready = installed && connected;
  const busy = isFetching || install.isPending;
  const error = (connect.error ?? install.error ?? doctor.error ?? checkError)?.message
    ?? (install.data && !install.data.ok ? "The Cua Driver installer did not finish. Its output is below." : undefined);
  const driverName = check?.version ? `Cua Driver ${check.version}` : "Cua Driver";
  const statusText = !supported
    ? "Available in the OfflineGPT desktop app"
    : !check ? "Checking for Cua Driver…"
    : !installed ? "Cua Driver is not installed on this computer"
    : !connected ? `${driverName} is installed. Enable it for this workspace.`
    : `Ready · ${driverName}`;

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Operate apps on this computer</CardTitle>
        <CardDescription>
          Computer Use runs Cua Driver, an open-source driver for native apps on macOS, Windows, and Linux. The agent targets one exact window, acts on its controls, and verifies the result.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh Computer Use status" onClick={() => void refetch()} disabled={busy}>
            <RefreshCw className={cn(busy && "animate-spin")} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-3 text-sm" role="status" aria-live="polite" data-testid="cua-driver-status">
          {ready ? <CheckCircle2 className="size-4 shrink-0 text-green-11" /> : <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 break-words">{statusText}</span>
        </div>

        {supported && check && !installed ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Install Cua Driver with its official installer. OfflineGPT downloads and runs this exact command from cua.ai:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs">{check.installCommand}</pre>
            <Button className="w-full" onClick={() => install.mutate()} disabled={install.isPending}>
              {install.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {install.isPending ? "Installing Cua Driver…" : "Install Cua Driver"}
            </Button>
          </div>
        ) : null}

        {installed && !connected ? (
          <Button className="w-full" onClick={() => connect.mutate()} disabled={connecting || connect.isPending || !onConnect}>
            {connecting || connect.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {connecting || connect.isPending ? "Enabling…" : "Enable Computer Use"}
          </Button>
        ) : null}

        {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
        {install.data?.output ? <Output label="Installer output" text={install.data.output} /> : null}

        <div className="space-y-3">
          <p className="text-sm font-medium">What the agent can do</p>
          <div className="grid gap-2">
            {capabilities.map(({ icon: Icon, name, description }) => (
              <div key={name} className="flex gap-3 rounded-xl border border-border p-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
              </div>
            ))}
          </div>
        </div>

        {installed ? <CuaCursorSettingsSection /> : null}

        {installed ? (
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium">Driver health</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{check.path}</p>
            </div>
            {check.permissions ? <Output label="macOS permissions (cua-driver permissions status)" text={check.permissions} /> : null}
            {check.status ? <Output label="cua-driver status" text={check.status} /> : null}
            <Button variant="outline" className="w-full" onClick={() => doctor.mutate()} disabled={doctor.isPending}>
              {doctor.isPending ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              Run cua-driver doctor
            </Button>
            {doctor.data ? <Output label={doctor.data.ok ? "Doctor passed" : "Doctor found problems"} text={doctor.data.output} /> : null}
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Enabling adds the Cua Driver MCP server (<code>computer-use</code>, running <code>cua-driver mcp</code>) and Cua's <code>cua-driver</code> skill to this workspace. Cua Driver keeps OS permissions and its own approval profile; window content goes to your selected model provider. Enter passwords yourself. For websites, prefer the built-in browser.
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border">
        <p className="max-w-sm text-xs text-muted-foreground">
          {ready ? "Mention an app in your next message, or ask the agent to use Computer Use." : "Powered by Cua Driver (MIT), github.com/trycua/cua."}
        </p>
      </CardFooter>
    </Card>
  );
}

function Output({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-[11px] leading-4">{text}</pre>
    </div>
  );
}
