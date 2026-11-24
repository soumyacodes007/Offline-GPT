"use client";

import { Ban, BookLock, CheckCircle2, Clock, Inbox, Plus, Search, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSelect } from "../../_components/ui/select";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { DenTextarea } from "../../_components/ui/textarea";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  accessResourceKindLabels,
  accessResourceKinds,
  approveAccessRequest,
  checkAccess,
  createRule,
  declineAccessRequest,
  durationChoices,
  durationLabel,
  relativeTime,
  removeRule,
  useAccessRequests,
  useAccessRules,
  useInvalidateAccess,
  type AccessCheck,
  type AccessRequest,
  type AccessResourceKind,
  type AccessRule,
  type Principal,
} from "./access-data";
import { memberName, PrincipalChip, PrincipalPicker, usePrincipalDirectory } from "./access-principals";
import { Empty, Field, useActions } from "./access-ui";
import { KnowledgeAdmin } from "./knowledge-admin";

type Tab = "requests" | "rules" | "check" | "knowledge";

export function AccessScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const requests = useAccessRequests(orgId, "all");
  const rules = useAccessRules(orgId);
  const pending = (requests.data ?? []).filter((request) => request.status === "pending");
  // Rules store ids; requests carry the names people used, so show those where we have them.
  const labels = new Map((requests.data ?? []).flatMap((request) => request.resourceLabel ? [[`${request.resourceKind}:${request.resourceId}`, request.resourceLabel] as const] : []));
  const [tab, setTab] = useState<Tab>("requests");

  return (
    <DashboardPageTemplate
      title="Access"
      description="Who can use which models, tools, connections and knowledge. Deny always wins; an allow limits a resource to the people it names."
      colors={["#0F172A", "#1E3A5F", "#3B6EA8", "#9CC3E6"]}
    >
      <UnderlineTabs<Tab>
        className="mb-6"
        activeTab={tab}
        onChange={setTab}
        tabs={[
          { value: "requests", label: "Requests", icon: Inbox, count: pending.length, countTone: "warning" },
          { value: "rules", label: "Rules", icon: ShieldCheck, count: rules.data?.filter((rule) => !rule.expired && !rule.resourceKind.startsWith("knowledge_")).length },
          { value: "check", label: "Check access", icon: Search },
          { value: "knowledge", label: "Knowledge", icon: BookLock },
        ]}
      />
      {!access.canManageSettings ? (
        <DenNotice tone="info" className="mb-6" message="You can review access here. Only owners and super-admins can change rules, approve requests, or add knowledge." />
      ) : null}
      {tab === "requests" ? <RequestsTab requests={requests.data ?? []} loading={requests.isLoading} error={requests.error} canDecide={access.canManageSettings} currentMemberId={orgContext?.currentMember.id ?? null} /> : null}
      {tab === "rules" ? <RulesTab rules={rules.data ?? []} labels={labels} loading={rules.isLoading} error={rules.error} canManage={access.canManageSettings} /> : null}
      {tab === "check" ? <CheckTab /> : null}
      {tab === "knowledge" ? <KnowledgeAdmin canManage={access.canManageSettings} /> : null}
    </DashboardPageTemplate>
  );
}

function resourceName(kind: AccessResourceKind, id: string, label?: string | null) {
  if (id === "*") return `every ${accessResourceKindLabels[kind].noun}`;
  return label ? `${label}` : `${accessResourceKindLabels[kind].noun} ${id}`;
}

/* ───────────────────────────── Requests ───────────────────────────── */

function RequestsTab({ requests, loading, error, canDecide, currentMemberId }: {
  requests: AccessRequest[];
  loading: boolean;
  error: Error | null;
  canDecide: boolean;
  currentMemberId: string | null;
}) {
  const [view, setView] = useState<"pending" | "history">("pending");
  const shown = requests.filter((request) => (view === "pending" ? request.status === "pending" : request.status !== "pending"));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <DenSegmented aria-label="Requests" value={view} onChange={setView} options={[{ value: "pending", label: "Waiting" }, { value: "history", label: "History" }]} />
        <p className="text-[13px] text-gray-500">Requests expire after 7 days without an answer.</p>
      </div>
      {error ? <DenNotice message={error.message} className="mb-4" /> : null}
      {loading ? <Empty title="Loading requests…" /> : shown.length === 0 ? (
        <Empty
          title={view === "pending" ? "Nothing waiting" : "No decisions yet"}
          body={view === "pending" ? "When someone asks for access, it shows up here with their reason." : "Approved, declined and expired requests are kept here."}
        />
      ) : (
        <div className="space-y-3">
          {shown.map((request) => (
            <RequestCard key={request.id} request={request} canDecide={canDecide && request.requesterOrgMembershipId !== currentMemberId} />
          ))}
        </div>
      )}
    </div>
  );
}

const statusTone = { pending: "warning", approved: "success", declined: "danger", cancelled: "neutral", expired: "neutral" } as const;

function RequestCard({ request, canDecide }: { request: AccessRequest; canDecide: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { entries } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  const [days, setDays] = useState(request.requestedDays === null ? "forever" : String(request.requestedDays));
  const [note, setNote] = useState("");
  const [declining, setDeclining] = useState(false);
  const chosen = durationChoices.find((choice) => choice.value === days) ?? durationChoices[1];
  const who = memberName(entries, request.requesterOrgMembershipId);
  const what = resourceName(request.resourceKind, request.resourceId, request.resourceLabel);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-gray-900">
            {who} wants to {accessResourceKindLabels[request.resourceKind].verb} <span className="text-[#1E3A5F]">{what}</span>
          </p>
          <p className="mt-1 text-[12px] text-gray-500">
            {accessResourceKindLabels[request.resourceKind].label} · asked {relativeTime(request.createdAt)} · for {durationLabel(request.requestedDays)}
            {request.status === "pending" ? ` · expires ${relativeTime(request.expiresAt)}` : ""}
          </p>
        </div>
        <DenChip tone={statusTone[request.status]} size="sm">{request.status}</DenChip>
      </div>
      <blockquote className="mt-3 rounded-xl bg-gray-50 px-4 py-3 text-[14px] leading-6 text-gray-700">“{request.purpose}”</blockquote>
      {request.status !== "pending" && request.decidedAt ? (
        <p className="mt-3 text-[12px] text-gray-500">
          {request.status === "cancelled" ? "Cancelled" : `${request.status === "approved" ? "Approved" : "Declined"} by ${request.decidedByOrgMembershipId ? memberName(entries, request.decidedByOrgMembershipId) : "an admin"}`} {relativeTime(request.decidedAt)}
          {request.decisionNote ? ` — “${request.decisionNote}”` : ""}
        </p>
      ) : null}
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      {request.status === "pending" && canDecide ? (
        <div className="mt-4 space-y-3">
          {declining ? (
            <DenTextarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional: tell them why, or what to do instead" aria-label="Reason for declining" />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {!declining ? (
              <>
                <div className="w-[170px]">
                  <DenSelect aria-label="Grant for" value={days} onChange={(event) => setDays(event.target.value)}>
                    {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </DenSelect>
                </div>
                <DenButton icon={CheckCircle2} loading={busy === "approve"} onClick={() => void run("approve", async () => {
                  await approveAccessRequest(request.id, { durationDays: chosen.days });
                  await invalidate();
                })}>Approve for {chosen.label.toLowerCase()}</DenButton>
                <DenButton variant="secondary" icon={XCircle} onClick={() => setDeclining(true)}>Decline…</DenButton>
              </>
            ) : (
              <>
                <DenButton variant="destructive" icon={XCircle} loading={busy === "decline"} onClick={() => void run("decline", async () => {
                  await declineAccessRequest(request.id, note.trim() || undefined);
                  await invalidate();
                })}>Decline request</DenButton>
                <DenButton variant="ghost" onClick={() => setDeclining(false)}>Back</DenButton>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── Rules ───────────────────────────── */

type Labels = ReadonlyMap<string, string>;

function RulesTab({ rules, labels, loading, error, canManage }: { rules: AccessRule[]; labels: Labels; loading: boolean; error: Error | null; canManage: boolean }) {
  const [kind, setKind] = useState<AccessResourceKind | "all">("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const { describe } = usePrincipalDirectory();
  // Knowledge rules are managed on the document itself, where their meaning is visible.
  const visible = rules.filter((rule) => !rule.resourceKind.startsWith("knowledge_"));
  const filtered = visible.filter((rule) => (kind === "all" || rule.resourceKind === kind) && (showExpired || !rule.expired) && (
    !query.trim() || `${rule.resourceId} ${labels.get(`${rule.resourceKind}:${rule.resourceId}`) ?? ""} ${describe(rule).label} ${rule.reason ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  ));
  const groups = useMemo(() => {
    const map = new Map<string, AccessRule[]>();
    for (const rule of filtered) map.set(`${rule.resourceKind}\n${rule.resourceId}`, [...(map.get(`${rule.resourceKind}\n${rule.resourceId}`) ?? []), rule]);
    return [...map.entries()];
  }, [filtered]);
  const kindsInUse = accessResourceKinds.filter((candidate) => !candidate.startsWith("knowledge_") && visible.some((rule) => rule.resourceKind === candidate));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1"><DenInput icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search resources, people, reasons" aria-label="Search rules" /></div>
        <div className="w-[200px]">
          <DenSelect aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value === "all" ? "all" : accessResourceKinds.find((candidate) => candidate === event.target.value) ?? "all")}>
            <option value="all">All kinds</option>
            {kindsInUse.map((candidate) => <option key={candidate} value={candidate}>{accessResourceKindLabels[candidate].label}</option>)}
          </DenSelect>
        </div>
        <DenButton icon={Plus} disabled={!canManage} onClick={() => setAdding(true)}>Add rule</DenButton>
      </div>
      {adding ? <RuleEditor onDone={() => setAdding(false)} /> : null}
      {error ? <DenNotice message={error.message} className="mb-4" /> : null}
      {loading ? <Empty title="Loading rules…" /> : groups.length === 0 ? (
        <Empty title={visible.length === 0 ? "No rules yet" : "No rules match"} body={visible.length === 0 ? "Without rules, each resource keeps its normal sharing. Add a rule to limit a model to a team, or block one action for everyone." : undefined} />
      ) : (
        <div className="space-y-3">
          {groups.map(([key, groupRules]) => <RuleGroup key={key} rules={groupRules} label={labels.get(`${groupRules[0].resourceKind}:${groupRules[0].resourceId}`)} canManage={canManage} />)}
        </div>
      )}
      <label className="mt-4 flex items-center gap-2 text-[13px] text-gray-500">
        <input type="checkbox" checked={showExpired} onChange={(event) => setShowExpired(event.target.checked)} /> Show expired rules
      </label>
    </div>
  );
}

function ruleSentence(rule: AccessRule, label: string, resourceLabel?: string) {
  const what = resourceName(rule.resourceKind, rule.resourceId, resourceLabel);
  const verb = accessResourceKindLabels[rule.resourceKind].verb;
  return rule.effect === "deny" ? `${label} can't ${verb} ${what}` : `${label} can ${verb} ${what}`;
}

function RuleGroup({ rules, label, canManage }: { rules: AccessRule[]; label?: string; canManage: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  const first = rules[0];
  const restricted = rules.some((rule) => rule.effect === "allow" && !rule.expired);
  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-gray-900">{resourceName(first.resourceKind, first.resourceId, label)}</p>
          <p className="text-[12px] text-gray-500">{accessResourceKindLabels[first.resourceKind].label}{first.resourceId !== "*" ? <span className="font-mono"> · {first.resourceId}</span> : null}</p>
        </div>
        {restricted ? <DenChip tone="info">Limited to the people below</DenChip> : null}
      </div>
      {error ? <DenNotice message={error} className="mx-5 mt-3" /> : null}
      <ul className="divide-y divide-gray-100">
        {rules.map((rule) => {
          const principal = describe(rule);
          return (
            <li key={rule.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${rule.expired ? "opacity-50" : ""}`}>
              {rule.effect === "allow"
                ? <DenChip tone="success" icon={CheckCircle2}>Allow</DenChip>
                : <DenChip tone="danger" icon={Ban}>Deny</DenChip>}
              <PrincipalChip principal={principal} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-gray-700">{ruleSentence(rule, principal.label, label)}</p>
                {rule.reason ? <p className="truncate text-[12px] text-gray-500">{rule.reason}</p> : null}
              </div>
              <span className="inline-flex items-center gap-1 text-[12px] text-gray-500">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {rule.expiresAt ? (rule.expired ? "expired" : `ends ${relativeTime(rule.expiresAt)}`) : "no end date"}
              </span>
              {canManage ? (
                <DenButton variant="ghost" size="sm" icon={Trash2} loading={busy === rule.id} aria-label="Remove rule" onClick={() => {
                  if (!confirm(`Remove this rule? ${ruleSentence(rule, principal.label, label)}.`)) return;
                  void run(rule.id, async () => {
                    await removeRule(rule.id);
                    await invalidate();
                  });
                }}>Remove</DenButton>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ruleKinds = accessResourceKinds.filter((kind) => !kind.startsWith("knowledge_"));

function RuleEditor({ onDone }: { onDone: () => void }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  const [kind, setKind] = useState<AccessResourceKind>("model");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [resourceId, setResourceId] = useState("");
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [until, setUntil] = useState("forever");
  const [reason, setReason] = useState("");
  const target = scope === "all" ? "*" : resourceId.trim();
  const ready = Boolean(principal && target);
  const days = durationChoices.find((choice) => choice.value === until)?.days ?? null;
  const preview = principal && target
    ? effect === "allow"
      ? `${describe(principal).label} can ${accessResourceKindLabels[kind].verb} ${resourceName(kind, target)}. Anyone without an allow rule or an existing grant loses access to it.`
      : `${describe(principal).label} can't ${accessResourceKindLabels[kind].verb} ${resourceName(kind, target)}, even if it is shared with them.`
    : "Pick what and who to see what this rule will do.";

  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5">
      <p className="mb-4 text-[15px] font-semibold text-gray-900">New rule</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What">
          <DenSelect aria-label="Resource kind" value={kind} onChange={(event) => setKind(ruleKinds.find((candidate) => candidate === event.target.value) ?? "model")}>
            {ruleKinds.map((candidate) => <option key={candidate} value={candidate}>{accessResourceKindLabels[candidate].label}</option>)}
          </DenSelect>
        </Field>
        <Field label="Which">
          <div className="flex gap-2">
            <DenSegmented aria-label="Scope" value={scope} onChange={setScope} options={[{ value: "one", label: "One" }, { value: "all", label: "All" }]} />
            {scope === "one" ? <DenInput value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder={accessResourceKindLabels[kind].hint} aria-label="Resource id" /> : null}
          </div>
        </Field>
        <Field label="Who"><PrincipalPicker value={principal} onChange={setPrincipal} /></Field>
        <Field label="Effect">
          <DenSegmented aria-label="Effect" value={effect} onChange={setEffect} options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]} />
        </Field>
        <Field label="Until">
          <DenSelect aria-label="Until" value={until} onChange={(event) => setUntil(event.target.value)}>
            {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.days === null ? "No end date" : `For ${choice.label}`}</option>)}
          </DenSelect>
        </Field>
        <Field label="Reason (kept in the audit log)">
          <DenInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Coder model is licensed for IT only" aria-label="Reason" />
        </Field>
      </div>
      <p className={`mt-4 rounded-xl px-4 py-3 text-[13px] ${effect === "deny" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{preview}</p>
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      <div className="mt-4 flex gap-2">
        <DenButton disabled={!ready} loading={busy === "save"} onClick={() => principal && void run("save", async () => {
          await createRule({
            ...principal,
            resourceKind: kind,
            resourceId: target,
            effect,
            ...(days === null ? {} : { expiresAt: new Date(Date.now() + days * 86400000).toISOString() }),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          });
          await invalidate();
          onDone();
        })}>Save rule</DenButton>
        <DenButton variant="ghost" onClick={onDone}>Cancel</DenButton>
      </div>
    </div>
  );
}

/* ───────────────────────────── Check access ───────────────────────────── */

function CheckTab() {
  const { describe } = usePrincipalDirectory();
  const [member, setMember] = useState<Principal | null>(null);
  const [kind, setKind] = useState<AccessResourceKind>("model");
  const [resourceId, setResourceId] = useState("");
  const [result, setResult] = useState<AccessCheck | null>(null);
  const { error, busy, run } = useActions();
  const { orgId } = useOrgDashboard();
  const rules = useAccessRules(orgId);
  const rule = result?.decision.ruleId ? rules.data?.find((candidate) => candidate.id === result.decision.ruleId) : undefined;
  const name = member ? describe(member).label : "";
  const verb = accessResourceKindLabels[kind].verb;
  const explanation: Record<string, string> = {
    policy: rule ? `because of a rule: ${ruleSentence(rule, describe(rule).label)}${rule.reason ? ` (${rule.reason})` : ""}.` : "because of an access rule.",
    open: "because it is open to everyone and no rule limits it.",
    restricted: "because rules limit it to other people, and they hold no grant of their own.",
    default: "because it isn't shared with them and no rule allows it. Their own grants are not counted here.",
    grant: "because it is shared with them.",
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <p className="mb-4 text-[14px] text-gray-600">See what the rules decide for one person, and why. Use it for access reviews.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Person"><PrincipalPicker value={member} onChange={(value) => { setMember(value); setResult(null); }} only={["member"]} ariaLabel="Person" /></Field>
        <Field label="What">
          <DenSelect aria-label="Resource kind" value={kind} onChange={(event) => { setKind(accessResourceKinds.find((candidate) => candidate === event.target.value) ?? "model"); setResult(null); }}>
            {accessResourceKinds.map((candidate) => <option key={candidate} value={candidate}>{accessResourceKindLabels[candidate].label}</option>)}
          </DenSelect>
        </Field>
        <Field label="Which"><DenInput value={resourceId} onChange={(event) => { setResourceId(event.target.value); setResult(null); }} placeholder={accessResourceKindLabels[kind].hint} aria-label="Resource id" /></Field>
      </div>
      <div className="mt-4">
        <DenButton icon={Search} disabled={!member || !resourceId.trim()} loading={busy === "check"} onClick={() => member && void run("check", async () => {
          setResult(await checkAccess({ memberId: member.principalId, resourceKind: kind, resourceId: resourceId.trim() }));
        })}>Check</DenButton>
      </div>
      {error ? <DenNotice message={error} className="mt-4" /> : null}
      {result ? (
        <div className={`mt-4 rounded-xl px-4 py-4 ${result.decision.allowed ? "bg-emerald-50" : "bg-red-50"}`}>
          <p className={`text-[15px] font-semibold ${result.decision.allowed ? "text-emerald-800" : "text-red-800"}`}>
            {name} {result.decision.allowed ? "can" : "can't"} {verb} {resourceName(kind, resourceId.trim())}
          </p>
          <p className="mt-1 text-[13px] text-gray-700">{explanation[result.decision.via] ?? ""}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="text-[12px] text-gray-500">Counted as:</span>
            {result.principals.map((p) => <PrincipalChip key={`${p.kind}:${p.id}`} principal={describe({ principalKind: p.kind, principalId: p.id })} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
