import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api, hitSchema, KINDS, requestSchema, type Me } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Field, formatDate, inputClass } from "../ui";

const workspaceSchema = z.object({ workspace: z.object({ status: z.enum(["running", "stopped"]), url: z.string() }).nullable() });

function WorkspaceCard() {
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: () => api(workspaceSchema, "/v1/me/workspace"), retry: false });
  const start = useMutation({
    mutationFn: () => api(workspaceSchema, "/v1/me/workspace", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["workspace"], data);
      if (data.workspace) window.open(data.workspace.url, "_blank", "noopener");
    },
  });
  const running = workspace.data?.workspace?.status === "running";
  return (
    <Card title="Your workspace" description="A private workspace where the assistant works on your files with the organization's models.">
      {workspace.isError ? <p className="text-sm text-slate-500">Workspaces are not set up on this deployment.</p> : (
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={running ? "green" : "slate"}>{running ? "Running" : "Stopped"}</Badge>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? "Starting…" : running ? "Open workspace" : "Start workspace"}</Button>
          <ErrorText error={start.error} />
        </div>
      )}
    </Card>
  );
}

function SearchCard() {
  const [query, setQuery] = useState("");
  const search = useMutation({ mutationFn: () => api(z.object({ results: z.array(hitSchema) }), "/v1/knowledge/search", { method: "POST", body: { query } }) });
  return (
    <Card title="Search company knowledge" description="Shows only what you are allowed to read.">
      <form className="flex gap-2" onSubmit={(event: FormEvent) => { event.preventDefault(); search.mutate(); }}>
        <input className={`${inputClass} flex-1`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. parental leave" />
        <Button type="submit" disabled={!query.trim() || search.isPending}>Search</Button>
      </form>
      <ErrorText error={search.error} />
      <div className="mt-4 grid gap-3">
        {search.data?.results.length === 0 ? <Empty>Nothing you can read matches that search.</Empty> : null}
        {search.data?.results.map((hit) => (
          <article key={hit.section} className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs text-slate-500">{hit.title} · {hit.path} {hit.sensitivity !== "ordinary" ? <Badge tone="amber">{hit.sensitivity}</Badge> : null}</p>
            <h3 className="mt-1 text-sm font-semibold">{hit.heading}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{hit.text}</p>
          </article>
        ))}
      </div>
    </Card>
  );
}

const requestsSchema = z.object({ requests: z.array(requestSchema) });
const DURATIONS = [{ label: "1 day", value: 1 }, { label: "7 days", value: 7 }, { label: "30 days", value: 30 }, { label: "90 days", value: 90 }, { label: "Until removed", value: null }] as const;

function MyRequestsCard() {
  const queryClient = useQueryClient();
  const requests = useQuery({ queryKey: ["my-requests"], queryFn: () => api(requestsSchema, "/v1/requests") });
  const [form, setForm] = useState<{ kind: (typeof KINDS)[number]; target: string; purpose: string; duration: number | null }>({ kind: "model", target: "", purpose: "", duration: 7 });
  const create = useMutation({
    mutationFn: () => api(z.unknown(), "/v1/requests", { method: "POST", body: { kind: form.kind, target: form.target, purpose: form.purpose, durationDays: form.duration } }),
    onSuccess: async () => {
      setForm({ ...form, target: "", purpose: "" });
      await queryClient.invalidateQueries({ queryKey: ["my-requests"] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(z.unknown(), `/v1/requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-requests"] }),
  });
  const tone = { pending: "amber", approved: "green", declined: "red", cancelled: "slate", expired: "slate" } as const;
  return (
    <Card title="Ask for access" description="Need a model, document or tool you can't use yet? Ask, and an administrator decides.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
        <Field label="What kind of thing">
          <select className={inputClass} value={form.kind} onChange={(event) => setForm({ ...form, kind: KINDS.find((kind) => kind === event.target.value) ?? "model" })}>
            {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </Field>
        <Field label="Which one" hint="Its name or path, e.g. qwen-32b or policies/finance/*"><input className={inputClass} value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} required /></Field>
        <Field label="Why you need it"><input className={inputClass} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} required /></Field>
        <Field label="For how long">
          <select className={inputClass} value={String(form.duration)} onChange={(event) => setForm({ ...form, duration: DURATIONS.find((option) => String(option.value) === event.target.value)?.value ?? 7 })}>
            {DURATIONS.map((option) => <option key={option.label} value={String(option.value)}>{option.label}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2 flex items-center gap-3"><Button type="submit" disabled={create.isPending}>Send request</Button><ErrorText error={create.error} /></div>
      </form>
      <div className="mt-5 grid gap-2">
        {requests.data?.requests.length === 0 ? <Empty>No requests yet.</Empty> : null}
        {requests.data?.requests.map((request) => (
          <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <div>
              <p className="font-medium">{request.kind}: {request.target}</p>
              <p className="text-xs text-slate-500">{request.purpose} · asked {formatDate(request.createdAt)}{request.note ? ` · Note: ${request.note}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={tone[request.status]}>{request.status}</Badge>
              {request.status === "pending" ? <Button tone="secondary" onClick={() => cancel.mutate(request.id)}>Cancel</Button> : null}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Home({ me }: { me: Me }) {
  return (
    <div className="grid gap-5">
      <p className="text-sm text-slate-500">Signed in as {me.name} ({me.email}){me.teams.length ? ` · ${me.teams.map((team) => team.name).join(", ")}` : ""}</p>
      <WorkspaceCard />
      <SearchCard />
      <MyRequestsCard />
    </div>
  );
}
