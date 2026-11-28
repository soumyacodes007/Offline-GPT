import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api, auditSchema, documentSchema, memberSchema, sectionSchema, teamSchema, usageSchema, type Me, type MemberRow } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Field, formatDate, inputClass } from "../ui";

export function People({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ["members"], queryFn: () => api(z.object({ members: z.array(memberSchema) }), "/v1/members") });
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => api(z.object({ teams: z.array(teamSchema) }), "/v1/teams") });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api(z.unknown(), `/v1/members/${id}/role`, { method: "PATCH", body: { role } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
  });
  const scimToken = useMutation({ mutationFn: () => api(z.object({ token: z.string() }), "/v1/settings/scim-token", { method: "POST" }) });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api(rolesSchema, "/v1/roles") });
  const setCustomRole = useMutation({
    mutationFn: ({ id, customRoleId }: { id: string; customRoleId: string | null }) => api(z.unknown(), `/v1/members/${id}/custom-role`, { method: "PATCH", body: { customRoleId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
  });
  const teamName = (id: string) => teams.data?.teams.find((team) => team.id === id)?.name ?? id;
  return (
    <div className="grid gap-5">
      <Card title="People" description="People come from your directory (SCIM). Deactivate people there; they lose access at once.">
        <ErrorText error={setRole.error ?? setCustomRole.error} />
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="py-2">Person</th><th>Teams</th><th>Status</th><th>Role</th><th>Extra permissions</th></tr></thead>
          <tbody>
            {members.data?.members.map((member) => (
              <tr key={member.id} className="border-t border-slate-100">
                <td className="py-2"><p className="font-medium">{member.name}</p><p className="text-xs text-slate-500">{member.email}</p></td>
                <td className="text-xs">{member.teamIds.map(teamName).join(", ") || "—"}</td>
                <td><Badge tone={member.active ? "green" : "slate"}>{member.active ? "Active" : "Deactivated"}</Badge></td>
                <td>
                  {me.role === "owner" ? (
                    <select className={inputClass} value={member.role} onChange={(event) => setRole.mutate({ id: member.id, role: event.target.value })}>
                      <option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option>
                    </select>
                  ) : member.role}
                </td>
                <td>
                  {member.role !== "member" ? <span className="text-xs text-slate-500">All</span> : me.role === "owner" ? (
                    <select className={inputClass} value={member.customRoleId ?? ""} onChange={(event) => setCustomRole.mutate({ id: member.id, customRoleId: event.target.value || null })}>
                      <option value="">None</option>
                      {roles.data?.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                    </select>
                  ) : <span className="text-xs">{roles.data?.roles.find((role) => role.id === member.customRoleId)?.name ?? "None"}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Teams people={members.data?.members ?? []} />
      {me.role === "owner" ? <Roles /> : null}
      {me.role === "owner" ? (
        <Card title="Directory sync (SCIM)" description="Paste this token into your identity provider's provisioning settings. Making a new one stops the old one.">
          <Button onClick={() => scimToken.mutate()} disabled={scimToken.isPending}>Make a new SCIM token</Button>
          {scimToken.data ? <p className="mt-3 break-all rounded-lg bg-slate-100 p-3 font-mono text-xs">{scimToken.data.token}</p> : null}
          <ErrorText error={scimToken.error} />
        </Card>
      ) : null}
    </div>
  );
}

function DocumentSections({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["document", id], queryFn: () => api(z.object({ sections: z.array(sectionSchema) }), `/v1/knowledge/documents/${id}`) });
  const label = useMutation({
    mutationFn: ({ sectionId, sensitivity }: { sectionId: string; sensitivity: string }) => api(z.unknown(), `/v1/knowledge/sections/${sectionId}`, { method: "PATCH", body: { sensitivity } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["document", id] }),
  });
  return (
    <div className="mt-3 grid gap-2">
      {detail.data?.sections.map((section) => (
        <div key={section.id} className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{section.heading} <span className="font-mono text-xs text-slate-400">{section.resourceId}</span></p>
            <select className={inputClass} value={section.sensitivity} onChange={(event) => label.mutate({ sectionId: section.id, sensitivity: event.target.value })}>
              <option value="ordinary">Ordinary</option><option value="sensitive">Sensitive (reads are logged)</option><option value="restricted">Restricted (needs its own rule)</option>
            </select>
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-slate-600">{section.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Knowledge() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ path: "", title: "", content: "", everyone: true });
  const [file, setFile] = useState<{ name: string; format: "pdf" | "docx"; base64: string } | null>(null);
  const documents = useQuery({ queryKey: ["documents"], queryFn: () => api(z.object({ documents: z.array(documentSchema) }), "/v1/knowledge/documents") });
  const upload = useMutation({
    mutationFn: () => api(z.unknown(), "/v1/knowledge/documents", { method: "POST", body: { path: form.path, title: form.title, ...(file ? { file: { format: file.format, base64: file.base64 } } : { content: form.content }), audience: form.everyone ? [{ type: "role", id: "member" }, { type: "role", id: "admin" }, { type: "role", id: "owner" }] : [] } }),
    onSuccess: async () => {
      setForm({ path: "", title: "", content: "", everyone: true });
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(z.unknown(), `/v1/knowledge/documents/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["documents"] }),
  });
  const readFile = async (picked: File | undefined) => {
    if (!picked) return;
    const title = picked.name.replace(/\.[^.]+$/, "");
    const extension = picked.name.split(".").pop()?.toLowerCase();
    if (extension === "pdf" || extension === "docx") {
      setFile({ name: picked.name, format: extension, base64: await fileToBase64(picked) });
      setForm((current) => ({ ...current, content: "", title: current.title || title }));
      return;
    }
    setFile(null);
    const text = await picked.text();
    setForm((current) => ({ ...current, content: text, title: current.title || title }));
  };
  return (
    <div className="grid gap-5">
      <Card title="Add a document" description="PDF, Word, Markdown or plain text. Documents are private until you choose who can read them; add more readers with rules on the Access page.">
        <form className="grid gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); upload.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Path" hint="Its id for rules, e.g. policies/hr/leave"><input className={inputClass} value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} required /></Field>
            <Field label="Title"><input className={inputClass} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></Field>
          </div>
          <Field label="File" hint="PDF, Word (.docx), Markdown or text."><input type="file" accept=".pdf,.docx,.md,.txt,text/markdown,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} /></Field>
          {file ? <p className="text-sm text-slate-600">{file.name} will be converted to text when you add it.</p> : <Field label="Text"><textarea className={`${inputClass} h-40 font-mono`} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} required /></Field>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.everyone} onChange={(event) => setForm({ ...form, everyone: event.target.checked })} /> Everyone in the organization can read it</label>
          <div className="flex items-center gap-3"><Button type="submit" disabled={upload.isPending}>Add document</Button><ErrorText error={upload.error} /></div>
        </form>
      </Card>
      <Card title="Documents">
        {documents.data?.documents.length === 0 ? <Empty>No documents yet.</Empty> : null}
        <div className="grid gap-2">
          {documents.data?.documents.map((document) => (
            <div key={document.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div><p className="font-medium">{document.title}</p><p className="font-mono text-xs text-slate-500">{document.path} · {document.sections} sections</p></div>
                <div className="flex gap-2">
                  <Button tone="secondary" onClick={() => setOpen(open === document.id ? null : document.id)}>{open === document.id ? "Hide sections" : "Sections"}</Button>
                  <Button tone="danger" onClick={() => remove.mutate(document.id)}>Delete</Button>
                </div>
              </div>
              {open === document.id ? <DocumentSections id={document.id} /> : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function Usage() {
  const [days, setDays] = useState(7);
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api(z.object({ usage: z.array(usageSchema) }), `/v1/usage?days=${days}`) });
  return (
    <Card title="Model usage" description="Counted by the model gateway inside your network. Nothing is sent anywhere else." actions={
      <select className={inputClass} value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>Today</option><option value={7}>7 days</option><option value={30}>30 days</option></select>
    }>
      {usage.data?.usage.length === 0 ? <Empty>No model calls in this period.</Empty> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="py-2">Person</th><th>Model</th><th className="text-right">Calls</th><th className="text-right">Failed</th><th className="text-right">Input tokens</th><th className="text-right">Output tokens</th></tr></thead>
          <tbody>{usage.data?.usage.map((row) => (
            <tr key={`${row.memberId}-${row.model}`} className="border-t border-slate-100">
              <td className="py-2">{row.email}</td><td>{row.model}</td><td className="text-right tabular-nums">{row.calls}</td><td className="text-right tabular-nums">{row.failed}</td><td className="text-right tabular-nums">{row.promptTokens.toLocaleString()}</td><td className="text-right tabular-nums">{row.completionTokens.toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

export function Audit() {
  const [filter, setFilter] = useState("");
  const events = useQuery({ queryKey: ["audit", filter], queryFn: () => api(z.object({ events: z.array(auditSchema), nextBefore: z.number().nullable() }), `/v1/audit?limit=100${filter ? `&action=${encodeURIComponent(filter)}` : ""}`) });
  return (
    <Card title="Audit log" description="Every change and every sensitive read, newest first." actions={
      <div className="flex items-center gap-3">
        <a href="/v1/audit/export" className="text-sm text-slate-600 underline">Download (JSON Lines)</a>
        <select className={inputClass} value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="">Everything</option><option value="rule.">Rules</option><option value="request.">Requests</option><option value="member.">People</option><option value="knowledge.">Knowledge</option><option value="library.">Library</option><option value="connection.">Connections</option><option value="plugin.">Plugins</option><option value="auth.">Sign-ins</option><option value="workspace.">Workspaces</option>
        </select>
      </div>
    }>
      <ErrorText error={events.error} />
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500"><tr><th className="py-2">When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>{events.data?.events.map((event) => (
          <tr key={event.id} className="border-t border-slate-100 align-top">
            <td className="py-2 text-xs">{formatDate(event.at)}</td><td className="font-mono text-xs">{event.actor}</td><td>{event.action}</td><td className="max-w-md break-all font-mono text-xs text-slate-600">{JSON.stringify(event.details)}</td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

const skillSchema = z.object({ slug: z.string(), title: z.string(), description: z.string(), updatedAt: z.string() });

export function Library() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ slug: "", title: "", description: "", instructions: "" });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api(z.object({ skills: z.array(skillSchema) }), "/v1/library/skills") });
  const publish = useMutation({
    mutationFn: () => api(z.unknown(), "/v1/library/skills", { method: "POST", body: form }),
    onSuccess: async () => {
      setForm({ slug: "", title: "", description: "", instructions: "" });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const remove = useMutation({
    mutationFn: (slug: string) => api(z.unknown(), `/v1/library/skills/${slug}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return (
    <div className="grid gap-5">
      <Card title="Publish a skill" description="Reusable instructions the assistant can follow in everyone's workspace. Everyone can use a skill unless a rule on the Access page (kind: skill) limits it.">
        <form className="grid gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); publish.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Short name" hint="Lowercase letters, numbers and -, e.g. weekly-report"><input className={inputClass} value={form.slug} onChange={set("slug")} required /></Field>
            <Field label="Title"><input className={inputClass} value={form.title} onChange={set("title")} required /></Field>
          </div>
          <Field label="One-line description"><input className={inputClass} value={form.description} onChange={set("description")} required /></Field>
          <Field label="Instructions" hint="Markdown. Publishing the same short name again replaces it."><textarea className={`${inputClass} h-40 font-mono`} value={form.instructions} onChange={set("instructions")} required /></Field>
          <div className="flex items-center gap-3"><Button type="submit" disabled={publish.isPending}>Publish skill</Button><ErrorText error={publish.error} /></div>
        </form>
      </Card>
      <Card title="Skills">
        {skills.data?.skills.length === 0 ? <Empty>No skills yet.</Empty> : null}
        <div className="grid gap-2">
          {skills.data?.skills.map((skill) => (
            <div key={skill.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div><p className="font-medium">{skill.title} <span className="font-mono text-xs text-slate-400">{skill.slug}</span></p><p className="text-xs text-slate-500">{skill.description} · updated {formatDate(skill.updatedAt)}</p></div>
              <Button tone="danger" onClick={() => remove.mutate(skill.slug)}>Delete</Button>
            </div>
          ))}
        </div>
      </Card>
      <Plugins />
      <Connections />
    </div>
  );
}

const connectionSchema = z.object({ slug: z.string(), title: z.string(), description: z.string(), url: z.string(), headerName: z.string().nullable(), hasSecret: z.boolean(), updatedAt: z.string() });
const EMPTY_CONNECTION = { slug: "", title: "", description: "", url: "", headerName: "Authorization", headerValue: "" };

function Connections() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_CONNECTION);
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api(z.object({ connections: z.array(connectionSchema) }), "/v1/library/connections") });
  const save = useMutation({
    mutationFn: () => {
      const { headerName, headerValue, ...rest } = form;
      return api(z.unknown(), "/v1/library/connections", { method: "POST", body: headerValue ? { ...rest, header: { name: headerName, value: headerValue } } : rest });
    },
    onSuccess: async () => {
      setForm(EMPTY_CONNECTION);
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });
  const remove = useMutation({
    mutationFn: (slug: string) => api(z.unknown(), `/v1/library/connections/${slug}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return (
    <>
      <Card title="Connect a company tool" description="An MCP server the assistant can use, such as a ticket tracker or an internal database. Nobody can use a connection until a rule on the Access page (kind: mcp-connection) allows them. The credential is stored encrypted and never shown again.">
        <form className="grid gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Short name" hint="Lowercase letters, numbers and -, e.g. tracker"><input className={inputClass} value={form.slug} onChange={set("slug")} required /></Field>
            <Field label="Title"><input className={inputClass} value={form.title} onChange={set("title")} required /></Field>
          </div>
          <Field label="What it's for"><input className={inputClass} value={form.description} onChange={set("description")} required /></Field>
          <Field label="Server URL" hint="Its MCP endpoint, reachable from this server, e.g. http://tracker.internal:8080/mcp"><input className={inputClass} type="url" value={form.url} onChange={set("url")} required /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Credential header"><input className={inputClass} value={form.headerName} onChange={set("headerName")} /></Field>
            <Field label="Credential value" hint="Optional. Leave empty to keep the stored one."><input className={inputClass} type="password" value={form.headerValue} onChange={set("headerValue")} autoComplete="off" /></Field>
          </div>
          <div className="flex items-center gap-3"><Button type="submit" disabled={save.isPending}>Save connection</Button><ErrorText error={save.error} /></div>
        </form>
      </Card>
      <Card title="Connections">
        {connections.data?.connections.length === 0 ? <Empty>No connections yet.</Empty> : null}
        <div className="grid gap-2">
          {connections.data?.connections.map((connection) => (
            <div key={connection.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div>
                <p className="font-medium">{connection.title} <span className="font-mono text-xs text-slate-400">{connection.slug}</span>{connection.hasSecret ? <Badge tone="green">credential set</Badge> : null}</p>
                <p className="text-xs text-slate-500">{connection.url} · updated {formatDate(connection.updatedAt)}</p>
              </div>
              <Button tone="danger" onClick={() => remove.mutate(connection.slug)}>Delete</Button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

const pluginSchema = z.object({ slug: z.string(), title: z.string(), description: z.string(), version: z.string().nullable(), updatedAt: z.string(), skills: z.array(z.string()), connections: z.array(z.string()) });
const installReportSchema = z.object({
  plugin: z.object({ slug: z.string(), title: z.string() }),
  skills: z.array(z.string()),
  connections: z.array(z.object({ slug: z.string(), needsCredential: z.boolean() })),
  skipped: z.array(z.string()),
});

function Plugins() {
  const queryClient = useQueryClient();
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: () => api(z.object({ plugins: z.array(pluginSchema) }), "/v1/library/plugins") });
  const refresh = () => Promise.all(["plugins", "skills", "connections"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const install = useMutation({
    mutationFn: async (file: File) => api(installReportSchema, "/v1/library/plugins", { method: "POST", body: { base64: await fileToBase64(file) } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (slug: string) => api(z.unknown(), `/v1/library/plugins/${slug}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const report = install.data;
  const needCredential = report?.connections.filter((connection) => connection.needsCredential) ?? [];
  return (
    <>
      <Card title="Install a plugin" description="A .zip in the Claude plugin layout: skills and tool connections installed together. Nobody gets them until a rule on the Access page (kind: plugin) allows them. Installing the same plugin again updates it.">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".zip" className="text-sm" disabled={install.isPending} onChange={(event) => { const picked = event.target.files?.[0]; if (picked) install.mutate(picked); event.target.value = ""; }} />
          {install.isPending ? <span className="text-sm text-slate-500">Installing…</span> : null}
          <ErrorText error={install.error} />
        </div>
        {report ? (
          <div className="mt-3 grid gap-1 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-medium">Installed {report.plugin.title}: {report.skills.length} skills, {report.connections.length} connections.</p>
            {needCredential.length ? <p className="text-amber-700">Add a credential under Connections for: {needCredential.map((connection) => connection.slug).join(", ")}.</p> : null}
            {report.skipped.map((reason) => <p key={reason} className="text-slate-500">Skipped {reason}</p>)}
          </div>
        ) : null}
      </Card>
      <Card title="Plugins">
        {plugins.data?.plugins.length === 0 ? <Empty>No plugins installed.</Empty> : null}
        <div className="grid gap-2">
          {plugins.data?.plugins.map((plugin) => (
            <div key={plugin.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div>
                <p className="font-medium">{plugin.title} <span className="font-mono text-xs text-slate-400">{plugin.slug}{plugin.version ? ` v${plugin.version}` : ""}</span></p>
                <p className="text-xs text-slate-500">{plugin.description} · {plugin.skills.length} skills · {plugin.connections.length} connections · updated {formatDate(plugin.updatedAt)}</p>
              </div>
              <Button tone="danger" onClick={() => remove.mutate(plugin.slug)}>Uninstall</Button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Teams({ people }: { people: MemberRow[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; memberIds: string[] } | null>(null);
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => api(z.object({ teams: z.array(teamSchema) }), "/v1/teams") });
  const refresh = () => Promise.all(["teams", "members"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const create = useMutation({ mutationFn: () => api(z.unknown(), "/v1/teams", { method: "POST", body: { name } }), onSuccess: async () => { setName(""); await refresh(); } });
  const save = useMutation({
    mutationFn: (team: { id: string; memberIds: string[] }) => api(z.unknown(), `/v1/teams/${team.id}/members`, { method: "PUT", body: { memberIds: team.memberIds } }),
    onSuccess: async () => { setEditing(null); await refresh(); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(z.unknown(), `/v1/teams/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const membersOf = (id: string) => people.filter((person) => person.teamIds.includes(id)).map((person) => person.id);
  const toggle = (memberId: string) => editing && setEditing({ ...editing, memberIds: editing.memberIds.includes(memberId) ? editing.memberIds.filter((id) => id !== memberId) : [...editing.memberIds, memberId] });
  return (
    <Card title="Teams" description="Directory teams come from SCIM and change there. Make your own teams here, for example for a project, and use them in rules on the Access page.">
      <form className="mb-3 flex flex-wrap items-end gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
        <Field label="New team"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Button type="submit" disabled={create.isPending}>Create team</Button>
        <ErrorText error={create.error ?? save.error ?? remove.error} />
      </form>
      <div className="grid gap-2">
        {teams.data?.teams.map((team) => (
          <div key={team.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{team.name} <Badge tone={team.source === "manual" ? "amber" : "slate"}>{team.source === "manual" ? "Made here" : "Directory"}</Badge> <span className="text-xs text-slate-500">{team.members} people</span></p>
              {team.source === "manual" ? (
                <div className="flex gap-2">
                  <Button onClick={() => setEditing(editing?.id === team.id ? null : { id: team.id, memberIds: membersOf(team.id) })}>{editing?.id === team.id ? "Close" : "Choose people"}</Button>
                  <Button tone="danger" onClick={() => remove.mutate(team.id)}>Delete</Button>
                </div>
              ) : null}
            </div>
            {editing?.id === team.id ? (
              <div className="mt-3 grid gap-2">
                <div className="grid max-h-60 gap-1 overflow-y-auto sm:grid-cols-2">
                  {people.filter((person) => person.active).map((person) => (
                    <label key={person.id} className="flex items-center gap-2"><input type="checkbox" checked={editing.memberIds.includes(person.id)} onChange={() => toggle(person.id)} />{person.name} <span className="text-xs text-slate-500">{person.email}</span></label>
                  ))}
                </div>
                <div><Button onClick={() => save.mutate(editing)} disabled={save.isPending}>Save members</Button></div>
              </div>
            ) : null}
          </div>
        ))}
        {teams.data?.teams.length === 0 ? <Empty>No teams yet.</Empty> : null}
      </div>
    </Card>
  );
}

const rolesSchema = z.object({ permissions: z.array(z.string()), roles: z.array(z.object({ id: z.string(), name: z.string(), permissions: z.array(z.string()) })) });
const PERMISSION_LABELS: Record<string, string> = {
  people: "People and teams",
  access: "Access rules (can grant anything, including to themselves)",
  requests: "Decide access requests",
  knowledge: "Knowledge base",
  library: "Library: skills, connections, plugins",
  audit: "Audit log",
  usage: "Model usage",
};

function Roles() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api(rolesSchema, "/v1/roles") });
  const refresh = () => Promise.all(["roles", "members"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const create = useMutation({ mutationFn: () => api(z.unknown(), "/v1/roles", { method: "POST", body: { name, permissions: chosen } }), onSuccess: async () => { setName(""); setChosen([]); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api(z.unknown(), `/v1/roles/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const toggle = (permission: string) => setChosen(chosen.includes(permission) ? chosen.filter((item) => item !== permission) : [...chosen, permission]);
  return (
    <Card title="Roles" description="Give someone part of the admin console without making them an admin. Owners and admins always have everything.">
      <form className="mb-3 grid gap-3" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
        <Field label="Role name" hint="e.g. Knowledge editor, Auditor"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <div className="grid gap-1 sm:grid-cols-2">
          {roles.data?.permissions.map((permission) => (
            <label key={permission} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={chosen.includes(permission)} onChange={() => toggle(permission)} />{PERMISSION_LABELS[permission] ?? permission}</label>
          ))}
        </div>
        <div className="flex items-center gap-3"><Button type="submit" disabled={create.isPending || chosen.length === 0}>Create role</Button><ErrorText error={create.error ?? remove.error} /></div>
      </form>
      <div className="grid gap-2">
        {roles.data?.roles.map((role) => (
          <div key={role.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <div><p className="font-medium">{role.name}</p><p className="text-xs text-slate-500">{role.permissions.map((permission) => PERMISSION_LABELS[permission] ?? permission).join(" · ")}</p></div>
            <Button tone="danger" onClick={() => remove.mutate(role.id)}>Delete</Button>
          </div>
        ))}
        {roles.data?.roles.length === 0 ? <Empty>No roles yet.</Empty> : null}
      </div>
    </Card>
  );
}
