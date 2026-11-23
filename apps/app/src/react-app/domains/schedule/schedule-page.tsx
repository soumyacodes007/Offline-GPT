/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import type { ScheduleCreateRequest, ScheduleTarget, ScheduleTask, ScheduleTiming } from "@offlinegpt/types/schedule";

import type { OfflineGptServerClient } from "@/app/lib/offlinegpt-server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TimingKind = ScheduleTiming["kind"];
const TIMING_KINDS: TimingKind[] = ["after", "at", "every", "daily", "weekly", "cron", "rrule"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function describeTiming(timing: ScheduleTiming): string {
  switch (timing.kind) {
    case "after": return `Once, ${Math.round(timing.after_seconds / 60)} min after creation`;
    case "at": return typeof timing.at === "string" ? `Once at ${new Date(timing.at).toLocaleString()}` : `Once at ${timing.at.date} ${timing.at.time} (${timing.at.time_zone})`;
    case "every": return timing.every_seconds % 3600 === 0 ? `Every ${timing.every_seconds / 3600} h` : `Every ${Math.round(timing.every_seconds / 60)} min`;
    case "daily": return `Daily at ${timing.daily.time} (${timing.daily.time_zone})`;
    case "weekly": return `${timing.weekly.weekdays.map((day) => WEEKDAYS[day - 1]).join(", ")} at ${timing.weekly.time} (${timing.weekly.time_zone})`;
    case "cron": return `Cron ${timing.cron.expression} (${timing.cron.time_zone})`;
    case "rrule": return "Custom recurrence (RRULE)";
  }
}

function describeTarget(target: ScheduleTarget): string {
  if (target.kind === "new") return "New chat each time";
  if (target.kind === "new_once") return "One dedicated chat";
  return "Existing chat";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Host-owned scheduled tasks for one workspace, after DeepSeek Harness's Automation tasks page. */
export function SchedulePage({ client, workspaceId, onOpenSession }: {
  client: OfflineGptServerClient | null;
  workspaceId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["schedule", workspaceId], [workspaceId]);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey,
    enabled: Boolean(client && workspaceId),
    // Deliveries happen on the server's timer; keep next-run and history current.
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!client) throw new Error("OfflineGPT server is not connected.");
      return client.listScheduledTasks(workspaceId);
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const act = useMutation({
    mutationFn: async (work: () => Promise<unknown>) => work(),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(errorText(error)),
    onSettled: refresh,
  });

  const items = tasks.data?.items ?? [];
  const selected = items.find((task) => task.id === selectedId) ?? null;
  const hasEnded = items.some((task) => task.state === "ended");

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6" data-schedule-page>
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Scheduled tasks</h1>
          <p className="text-sm text-muted-foreground">Prompts OfflineGPT sends into a chat on a schedule, while the app is running. Agents can create them too: ask "remind me every weekday at 9".</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {hasEnded ? (
            <Button variant="outline" size="sm" disabled={!client || act.isPending} onClick={() => client && act.mutate(() => client.deleteEndedScheduledTasks(workspaceId))}>
              Clear ended
            </Button>
          ) : null}
          <Button size="sm" disabled={!client} onClick={() => setCreating(true)}><Plus className="size-4" />New task</Button>
        </div>
      </header>

      {actionError ? <p className="mb-3 text-sm text-destructive" role="alert">{actionError}</p> : null}
      {tasks.error ? <p className="mb-3 text-sm text-destructive" role="alert">{errorText(tasks.error)}</p> : null}

      {!tasks.isLoading && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarClock /></EmptyMedia>
            <EmptyTitle>No scheduled tasks</EmptyTitle>
            <EmptyDescription>Create one here, or ask OfflineGPT in a chat to schedule something.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((task) => (
          <li key={task.id} className="flex items-start gap-3 px-4 py-3" data-schedule-task={task.id}>
            <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setSelectedId(task.id)}>
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{task.title}</span>
                <Badge variant={task.state === "active" ? "default" : "secondary"}>{task.state}</Badge>
                {task.lastDelivery && !task.lastDelivery.ok ? <Badge variant="destructive">last run failed</Badge> : null}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {describeTiming(task.timing)} · {describeTarget(task.target)}
                {task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toLocaleString()}` : ""}
              </p>
            </button>
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" size="icon" title="Run now" aria-label="Run now" disabled={act.isPending || !client}
                onClick={() => client && act.mutate(() => client.runScheduledTask(workspaceId, task.id))}>
                <Zap className="size-4" />
              </Button>
              {task.state === "active" ? (
                <Button variant="ghost" size="icon" title="Pause" aria-label="Pause" disabled={act.isPending || !client}
                  onClick={() => client && act.mutate(() => client.updateScheduledTask(workspaceId, task.id, { active: false }))}>
                  <Pause className="size-4" />
                </Button>
              ) : task.state === "paused" ? (
                <Button variant="ghost" size="icon" title="Resume" aria-label="Resume" disabled={act.isPending || !client}
                  onClick={() => client && act.mutate(() => client.updateScheduledTask(workspaceId, task.id, { active: true }))}>
                  <Play className="size-4" />
                </Button>
              ) : null}
              <Button variant="ghost" size="icon" title="Delete" aria-label="Delete" disabled={act.isPending || !client}
                onClick={() => client && act.mutate(() => client.deleteScheduledTask(workspaceId, task.id))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {selected ? <TaskHistory task={selected} onClose={() => setSelectedId(null)} onOpenSession={onOpenSession} /> : null}
      {creating && client ? (
        <CreateTaskDialog
          onClose={() => setCreating(false)}
          onCreate={async (request) => {
            await client.createScheduledTask(workspaceId, request);
            setCreating(false);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function TaskHistory({ task, onClose, onOpenSession }: { task: ScheduleTask; onClose: () => void; onOpenSession: (sessionId: string) => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{task.title}</DialogTitle></DialogHeader>
        <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">{task.prompt}</p>
        <p className="text-xs text-muted-foreground">{describeTiming(task.timing)} · {describeTarget(task.target)}</p>
        <h3 className="mt-2 text-sm font-medium">Deliveries</h3>
        {task.history.length === 0 ? <p className="text-sm text-muted-foreground">Not delivered yet.</p> : (
          <ul className="max-h-64 space-y-1 overflow-auto text-sm">
            {task.history.map((entry) => (
              <li key={`${entry.deliveredAt}-${entry.scheduledAt}`} className="flex items-center justify-between gap-2">
                <span className={entry.ok ? "" : "text-destructive"}>
                  {new Date(entry.deliveredAt).toLocaleString()}{entry.manual ? " (run now)" : ""}{entry.ok ? "" : ` — ${entry.error ?? "failed"}`}
                </span>
                {entry.sessionId ? <Button variant="link" size="sm" onClick={() => entry.sessionId && onOpenSession(entry.sessionId)}>Open chat</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateTaskDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (request: ScheduleCreateRequest) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<TimingKind>("daily");
  const [time, setTime] = useState("09:00");
  const [zone, setZone] = useState(LOCAL_ZONE);
  const [minutes, setMinutes] = useState("60");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [date, setDate] = useState("");
  const [expression, setExpression] = useState("0 9 * * 1-5");
  const [rrule, setRrule] = useState("");
  const [target, setTarget] = useState<"new_once" | "new">("new_once");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const timing = (): ScheduleTiming => {
    switch (kind) {
      case "after": return { kind, after_seconds: Math.max(1, Math.round(Number(minutes) * 60)) };
      case "at": return { kind, at: { date, time, time_zone: zone } };
      case "every": return { kind, every_seconds: Math.max(60, Math.round(Number(minutes) * 60)) };
      case "daily": return { kind, daily: { time, time_zone: zone } };
      case "weekly": return { kind, weekly: { time, time_zone: zone, weekdays: [...weekdays].sort((a, b) => a - b) } };
      case "cron": return { kind, cron: { expression, time_zone: zone } };
      case "rrule": return { kind, rrule };
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title, prompt, timing: timing(), target: { kind: target } });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const showTime = kind === "daily" || kind === "weekly" || kind === "at";
  const showZone = showTime || kind === "cron";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New scheduled task</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label htmlFor="schedule-title">Name</Label>
            <Input id="schedule-title" value={title} maxLength={120} placeholder="Morning inbox summary" onChange={(event) => setTitle(event.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="schedule-prompt">Prompt</Label>
            <Textarea id="schedule-prompt" value={prompt} rows={4} placeholder="Summarize new email and list anything that needs a reply today." onChange={(event) => setPrompt(event.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Repeat</Label>
              <Select value={kind} onValueChange={(value) => { const next = TIMING_KINDS.find((entry) => entry === value); if (next) setKind(next); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">On weekdays I pick</SelectItem>
                  <SelectItem value="every">Every N minutes</SelectItem>
                  <SelectItem value="after">Once, in N minutes</SelectItem>
                  <SelectItem value="at">Once, at a date and time</SelectItem>
                  <SelectItem value="cron">Cron expression</SelectItem>
                  <SelectItem value="rrule">RRULE (advanced)</SelectItem>
                </SelectContent>
              </Select></div>
            <div className="grid gap-1.5"><Label>Deliver to</Label>
              <Select value={target} onValueChange={(value) => setTarget(value === "new" ? "new" : "new_once")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="new_once">One dedicated chat</SelectItem>
                  <SelectItem value="new">A new chat each time</SelectItem>
                </SelectContent>
              </Select></div>
          </div>
          {kind === "every" || kind === "after" ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-minutes">Minutes</Label>
              <Input id="schedule-minutes" type="number" min={kind === "every" ? 1 : 1} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></div>
          ) : null}
          {kind === "at" ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-date">Date</Label>
              <Input id="schedule-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
          ) : null}
          {showTime ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-time">Time</Label>
              <Input id="schedule-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></div>
          ) : null}
          {kind === "weekly" ? (
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((label, index) => {
                const day = index + 1;
                const on = weekdays.includes(day);
                return (
                  <Button key={label} type="button" size="sm" variant={on ? "default" : "outline"}
                    onClick={() => setWeekdays((current) => on ? current.filter((value) => value !== day) : [...current, day])}>
                    {label}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {kind === "cron" ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-cron">Cron (minute hour day month weekday)</Label>
              <Input id="schedule-cron" value={expression} onChange={(event) => setExpression(event.target.value)} /></div>
          ) : null}
          {kind === "rrule" ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-rrule">DTSTART and RRULE lines</Label>
              <Textarea id="schedule-rrule" rows={2} value={rrule} placeholder={"DTSTART;TZID=" + LOCAL_ZONE + ":20261201T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO"} onChange={(event) => setRrule(event.target.value)} /></div>
          ) : null}
          {showZone ? (
            <div className="grid gap-1.5"><Label htmlFor="schedule-zone">Time zone</Label>
              <Input id="schedule-zone" value={zone} onChange={(event) => setZone(event.target.value)} /></div>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !title.trim() || !prompt.trim()} onClick={() => void submit()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
