import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api, decisionSchema, describeCause, KINDS, memberSchema, requestSchema, ruleSchema, teamSchema, type AccessRule } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Field, formatDate, inputClass } from "../ui";

const membersQuery = { queryKey: ["members"], queryFn: () => api(z.object({ members: z.array(memberSchema) }), "/v1/members") };
const teamsQuery = { queryKey: ["teams"], queryFn: () => api(z.object({ teams: z.array(teamSchema) }), "/v1/teams") };

function usePeopleNames() {
  const members = useQuery(membersQuery);
  const teams = useQuery(teamsQuery);
  const memberName = (id: string | null) => members.data?.members.find((member) => member.id === id)?.email ?? id ?? "";
  const teamName = (id: string | null) => teams.data?.teams.find((team) => team.id === id)?.name ?? id ?? "";
  return { members: members.data?.members ?? [], teams: teams.data?.teams ?? [], memberName, teamName };
}

function PendingRequests() {
  const queryClient = useQueryClient();
  const { memberName } = usePeopleNames();
  const requests = useQuery({ queryKey: ["requests", "pending"], queryFn: () => api(z.object({ requests: z.array(requestSchema) }), "/v1/requests?all=1&status=pending") });
  const decide = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "approve" | "decline"; note?: string }) => api(z.unknown(), `/v1/requests/${id}/${action}`, { method: "POST", body: note ? { note } : {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["requests"] });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const pending = requests.data?.requests.filter((request) => request.status === "pending") ?? [];
  return (
    <Card title="Waiting for a decision" description="Approving adds a time-limited rule for that person. You can't decide your own requests.">
      <ErrorText error={decide.error} />
      {pending.length === 0 ? <Empty>No requests are waiting.</Empty> : (
        <div className="grid gap-2">
          {pending.map((request) => (
            <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div>
                <p className="font-medium">{memberName(request.memberId)} wants {request.kind}: {request.target}</p>
                <p className="text-xs text-slate-500">"{request.purpose}" · {request.durationDays ? `${request.durationDays} days` : "until removed"} · {formatDate(request.createdAt)}</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => decide.mutate({ id: request.id, action: "approve" })}>Approve</Button>
                <Button tone="secondary" onClick={() => decide.mutate({ id: request.id, action: "decline", note: window.prompt("Note for the requester (optional)") ?? undefined })}>Decline</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

type Principal = { type: "everyone" } | { type: "member" | "team"; id: string } | { type: "role"; id: "owner" | "admin" | "member" };

function NewRule() {
  const queryClient = useQueryClient();
  const { members, teams } = usePeopleNames();
  const [form, setForm] = useState({ kind: "model", target: "", effect: "allow", principalType: "team", principalId: "", reason: "", expiresAt: "" });
  const principal = (): Principal => {
    if (form.principalType === "everyone") return { type: "everyone" };
    if (form.principalType === "role") return { type: "role", id: form.principalId === "owner" || form.principalId === "admin" ? form.principalId : "member" };
    return { type: form.principalType === "member" ? "member" : "team", id: form.principalId };
  };
  const create = useMutation({
    mutationFn: () => api(z.unknown(), "/v1/rules", { method: "POST", body: { kind: form.kind, target: form.target, effect: form.effect, principal: principal(), reason: form.reason, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null } }),
    onSuccess: async () => {
      setForm({ ...form, target: "", reason: "" });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return (
    <Card title="Add a rule" description="A block always wins. An allow rule limits the thing to the people it names. End a target with * to cover everything that starts with it.">
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
        <Field label="Kind"><select className={inputClass} value={form.kind} onChange={set("kind")}>{KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></Field>
        <Field label="Target" hint="e.g. qwen-32b or policies/hr/*"><input className={inputClass} value={form.target} onChange={set("target")} required /></Field>
        <Field label="Effect"><select className={inputClass} value={form.effect} onChange={set("effect")}><option value="allow">Allow</option><option value="deny">Block</option></select></Field>
        <Field label="Who">
          <select className={inputClass} value={form.principalType} onChange={(event) => setForm({ ...form, principalType: event.target.value, principalId: "" })}>
            <option value="team">A team</option><option value="member">A person</option><option value="role">A role</option><option value="everyone">Everyone</option>
          </select>
        </Field>
        {form.principalType === "team" ? <Field label="Team"><select className={inputClass} value={form.principalId} onChange={set("principalId")} required><option value="">Choose…</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field> : null}
        {form.principalType === "member" ? <Field label="Person"><select className={inputClass} value={form.principalId} onChange={set("principalId")} required><option value="">Choose…</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></Field> : null}
        {form.principalType === "role" ? <Field label="Role"><select className={inputClass} value={form.principalId} onChange={set("principalId")}><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select></Field> : null}
        <Field label="Ends" hint="Leave empty to keep it until removed."><input className={inputClass} type="datetime-local" value={form.expiresAt} onChange={set("expiresAt")} /></Field>
        <Field label="Reason"><input className={inputClass} value={form.reason} onChange={set("reason")} required /></Field>
        <div className="sm:col-span-3 flex items-center gap-3"><Button type="submit" disabled={create.isPending}>Add rule</Button><ErrorText error={create.error} /></div>
      </form>
    </Card>
  );
}

function RuleList() {
  const queryClient = useQueryClient();
  const { memberName, teamName } = usePeopleNames();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api(z.object({ rules: z.array(ruleSchema) }), "/v1/rules") });
  const remove = useMutation({
    mutationFn: (id: string) => api(z.unknown(), `/v1/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rules"] }),
  });
  const who = (rule: AccessRule) => rule.principalType === "everyone" ? "Everyone" : rule.principalType === "member" ? memberName(rule.principalRef) : rule.principalType === "team" ? `Team ${teamName(rule.principalRef)}` : `Role ${rule.principalRef ?? ""}`;
  return (
    <Card title="Rules">
      {rules.data?.rules.length === 0 ? <Empty>No rules yet. Everything uses its default.</Empty> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="py-2">Effect</th><th>Kind</th><th>Target</th><th>Who</th><th>Ends</th><th>Reason</th><th /></tr></thead>
          <tbody>
            {rules.data?.rules.map((rule) => (
              <tr key={rule.id} className="border-t border-slate-100">
                <td className="py-2"><Badge tone={rule.effect === "allow" ? "green" : "red"}>{rule.effect === "allow" ? "Allow" : "Block"}</Badge></td>
                <td>{rule.kind}</td><td className="font-mono text-xs">{rule.target}</td><td>{who(rule)}</td><td className="text-xs">{formatDate(rule.expiresAt)}</td><td className="text-xs text-slate-600">{rule.reason}</td>
                <td className="text-right"><Button tone="danger" onClick={() => remove.mutate(rule.id)}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function CheckAccess() {
  const { members } = usePeopleNames();
  const [form, setForm] = useState({ memberId: "", kind: "model", id: "" });
  const check = useMutation({ mutationFn: () => api(decisionSchema, "/v1/access/check", { method: "POST", body: form }) });
  return (
    <Card title="Check access" description="See whether a person can use something, and which rule decides it.">
      <form className="grid gap-3 sm:grid-cols-4" onSubmit={(event: FormEvent) => { event.preventDefault(); check.mutate(); }}>
        <Field label="Person"><select className={inputClass} value={form.memberId} onChange={(event) => setForm({ ...form, memberId: event.target.value })} required><option value="">Choose…</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></Field>
        <Field label="Kind"><select className={inputClass} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>{KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></Field>
        <Field label="Id"><input className={inputClass} value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} required /></Field>
        <div className="flex items-end"><Button type="submit">Check</Button></div>
      </form>
      <ErrorText error={check.error} />
      {check.data ? <p className="mt-3 text-sm"><Badge tone={check.data.allowed ? "green" : "red"}>{check.data.allowed ? "Allowed" : "Not allowed"}</Badge> {describeCause(check.data.cause)}</p> : null}
    </Card>
  );
}

export function Access() {
  return (
    <div className="grid gap-5">
      <PendingRequests />
      <CheckAccess />
      <NewRule />
      <RuleList />
    </div>
  );
}
