/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, MousePointer2, Play } from "lucide-react";
import type { CuaCursorSettingKey, CuaCursorSettings } from "@offlinegpt/types/desktop-ipc";

import { desktopBridge } from "@/app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const SETTINGS_QUERY_KEY = ["computer-use", "cua-driver", "cursor"];

type Option = { value: string; label: string };

const STYLE_OPTIONS: Option[] = [
  { value: "signature_arc", label: "Signature arc" },
  { value: "spring_settle", label: "Spring settle" },
  { value: "magnetic", label: "Magnetic" },
  { value: "comet_swoop", label: "Comet swoop" },
  { value: "adaptive", label: "Adaptive" },
  { value: "classic", label: "Classic" },
];

const TIMING_OPTIONS: Option[] = [
  { value: "default", label: "Steady (default)" },
  { value: "native", label: "Native" },
  { value: "fitts", label: "Distance-aware" },
  { value: "fixed", label: "Fixed" },
];

const ROTATE_OPTIONS: Option[] = [
  { value: "heading", label: "Points where it moves" },
  { value: "lean", label: "Leans into motion" },
  { value: "off", label: "Always upright" },
];

const TOGGLES: Array<{ key: CuaCursorSettingKey; field: "halo" | "float" | "trail" | "glow"; label: string; description: string }> = [
  { key: "cursor.halo", field: "halo", label: "Halo", description: "Soft glow around the cursor." },
  { key: "cursor.float", field: "float", label: "Float", description: "Gentle sway at rest; settles before every click." },
  { key: "cursor.motion.effects.trail", field: "trail", label: "Trail", description: "Fading trail while it moves." },
  { key: "cursor.motion.effects.glow", field: "glow", label: "Speed glow", description: "Glow that grows with speed." },
];

/** Cua Driver's agent cursor: the on-screen overlay that shows where the agent acts. */
export function CuaCursorSettingsSection() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => desktopBridge.getCuaCursorSettings(), retry: false });
  const update = useMutation({
    mutationFn: ({ key, value }: { key: CuaCursorSettingKey; value: string }) => desktopBridge.setCuaCursorSetting(key, value),
    onSuccess: (next: CuaCursorSettings) => queryClient.setQueryData(SETTINGS_QUERY_KEY, next),
  });
  const preview = useMutation({ mutationFn: () => desktopBridge.previewCuaCursor() });

  const value = settings.data;
  const error = (update.error ?? preview.error ?? settings.error)?.message;
  const set = (key: CuaCursorSettingKey, next: string) => update.mutate({ key, value: next });
  const busy = !value || update.isPending;

  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="cua-cursor-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium"><MousePointer2 className="size-4 text-muted-foreground" />Agent cursor</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A second, colored cursor shows where the agent is about to click or type. It never moves your own mouse. Changes apply to the next Computer Use task.
          </p>
        </div>
        <Switch
          aria-label="Show the agent cursor"
          checked={value?.enabled ?? false}
          disabled={busy}
          onCheckedChange={(checked) => set("agent_cursor.enabled", checked ? "true" : "false")}
        />
      </div>

      {!value && !settings.error ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Reading cursor settings…</p>
      ) : null}

      {value?.enabled ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <SettingSelect label="Motion" value={value?.style} options={STYLE_OPTIONS} disabled={busy} onChange={(next) => set("cursor.motion.style", next)} />
            <SettingSelect label="Speed" value={value?.timing} options={TIMING_OPTIONS} disabled={busy} onChange={(next) => set("cursor.motion.timing", next)} />
            <SettingSelect label="Pointing" value={value?.rotate} options={ROTATE_OPTIONS} disabled={busy} onChange={(next) => set("cursor.rotate", next)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {TOGGLES.map((toggle) => (
              <div key={toggle.key} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <div><p className="text-sm">{toggle.label}</p><p className="text-xs text-muted-foreground">{toggle.description}</p></div>
                <Switch
                  size="sm"
                  aria-label={toggle.label}
                  checked={value?.[toggle.field] ?? false}
                  disabled={busy}
                  onCheckedChange={(checked) => set(toggle.key, checked ? "on" : "off")}
                />
              </div>
            ))}
          </div>
          <Button variant="outline" className="w-full" onClick={() => preview.mutate()} disabled={busy || preview.isPending}>
            {preview.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {preview.isPending ? "Watch your screen…" : "Preview the cursor"}
          </Button>
        </>
      ) : null}

      {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
    </div>
  );
}

function SettingSelect(props: { label: string; value: string | undefined; options: Option[]; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <Select
        value={props.value ?? null}
        items={props.options}
        disabled={props.disabled}
        onValueChange={(next) => { if (typeof next === "string") props.onChange(next); }}
      >
        <SelectTrigger aria-label={props.label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}
