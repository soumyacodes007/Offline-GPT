"use client";

import { Ban, CheckCircle2, Inbox, Plus, Search, ShieldCheck, Trash2, UserSearch, XCircle } from "lucide-react";
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
import { ResourceIcon, ResourcePicker, useResourceNames, type PickedResource } from "./access-resources";
import { Empty, Field, useActions } from "./access-ui";

type Tab = "requests" | "rules" | "check";

/** Rules on documents and sections are set on the Knowledge page, where you can see the text they cover. */
const ruleKinds = accessResourceKinds.filter((kind) => !kind.startsWith("knowledge_"));
const checkKinds = accessResourceKinds.filter((kind) => kind !== "knowledge_chunk");

export function AccessScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const requests = useAccessRequests(orgId, "all");
  const rules = useAccessRules(orgId);
  const pending = (requests.data ?? []).filter((request) => request.status === "pending");
  const [tab, setTab] = useState<Tab>("requests");

  return (
    <DashboardPageTemplate
      title="Access"
      description="Decide who can use each model, connection, tool and skill. Anything without a rule keeps the sharing it has today."
      colors={["#0F172A", "#1E3A5F", "#3B6EA8", "#9CC3E6"]}
    >
      <UnderlineTabs<Tab>
        className="mb-6"
        activeTab={tab}
        onChange={setTab}
        tabs={[
          { value: "requests", label: "Requests", icon: Inbox, count: pending.length, countTone: "warning" },
          { value: "rules", label: "Rules", icon: ShieldCheck, count: rules.data?.filter((rule) => !rule.expired && !rule.resourceKind.startsWith("knowledge_")).length },
          { value: "check", label: "Check someone's access", icon: UserSearch },
        ]}
      />
      {!access.canManageSettings ? (
        <DenNotice tone="info" className="mb-6" message="You can look, but only owners and super-admins can change rules or answer requests." />
      ) : null}
      {tab === "requests" ? <RequestsTab requests={requests.data ?? []} loading={requests.isLoading} error={requests.error} canDecide={access.canManageSettings} currentMemberId={orgContext?.currentMember.id ?? null} /> : null}
      {tab === "rules" ? <RulesTab rules={rules.data ?? []} loading={rules.isLoading} error={rules.error} canManage={access.canManageSettings} /> : null}
      {tab === "check" ? <CheckTab /> : null}
    </DashboardPageTemplate>
  );
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DenSegmented aria-label="Requests" value={view} onChange={setView} options={[{ value: "pending", label: "Waiting for you" }, { value: "history", label: "Answered" }]} />
        <p className="text-[13px] text-gray-500">Unanswered requests close after 7 days.</p>
      </div>
      {error ? <DenNotice message={error.message} className="mb-4" /> : null}
      {loading ? <Empty title="Loading requests…" /> : shown.length === 0 ? (
        <Empty
          title={view === "pending" ? "You're all caught up" : "Nothing answered yet"}
          body={view === "pending" ? "When someone is blocked and asks for access, their request and reason show up here." : "Approved, declined and closed requests are kept here."}
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

const statusCopy = {
  pending: { label: "Waiting", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
  expired: { label: "Closed, no answer", tone: "neutral" },
} as const;

function RequestCard({ request, canDecide }: { request: AccessRequest; canDecide: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { entries } = usePrincipalDirectory();
  const nameOf = useResourceNames();
  const { error, busy, run } = useActions();
  const [days, setDays] = useState(request.requestedDays === null ? "forever" : String(request.requestedDays));
  const [note, setNote] = useState("");
  const [declining, setDeclining] = useState(false);
  const chosen = durationChoices.find((choice) => choice.value === days) ?? durationChoices[1];
  const who = memberName(entries, request.requesterOrgMembershipId);
  const what = nameOf(request.resourceKind, request.resourceId, request.resourceLabel);
  const kind = accessResourceKindLabels[request.resourceKind];

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50">
          <ResourceIcon kind={request.resourceKind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-[15px] font-semibold text-gray-900">
              {who} wants to {kind.verb} <span className="text-gray-900 underline decoration-gray-300 underline-offset-4">{what}</span>
            </p>
            <DenChip tone={statusCopy[request.status].tone} size="sm">{statusCopy[request.status].label}</DenChip>
          </div>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {kind.label} · asked {relativeTime(request.createdAt)} · for {durationLabel(request.requestedDays).toLowerCase()}
            {request.status === "pending" ? ` · closes ${relativeTime(request.expiresAt)}` : ""}
          </p>
          <p className="mt-3 border-l-2 border-gray-200 pl-3 text-[14px] leading-6 text-gray-700">{request.purpose}</p>
          {request.status !== "pending" && request.decidedAt ? (
            <p className="mt-3 text-[12px] text-gray-500">
              {request.status === "cancelled" ? "Withdrawn" : `${request.status === "approved" ? "Approved" : "Declined"} by ${request.decidedByOrgMembershipId ? memberName(entries, request.decidedByOrgMembershipId) : "an admin"}`} {relativeTime(request.decidedAt)}
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
                    <DenButton icon={CheckCircle2} loading={busy === "approve"} onClick={() => void run("approve", async () => {
                      await approveAccessRequest(request.id, { durationDays: chosen.days });
                      await invalidate();
                    })}>Approve</DenButton>
                    <div className="w-[150px]">
                      <DenSelect aria-label="Approve for" value={days} onChange={(event) => setDays(event.target.value)}>
                        {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.days === null ? "Until removed" : `For ${choice.label}`}</option>)}
                      </DenSelect>
                    </div>
                    <DenButton variant="ghost" icon={XCircle} onClick={() => setDeclining(true)}>Decline</DenButton>
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
      </div>
    </div>
  );
}

/* ───────────────────────────── Rules ───────────────────────────── */

function ruleSentence(rule: Pick<AccessRule, "effect" | "resourceKind">, who: string, what: string) {
  const verb = accessResourceKindLabels[rule.resourceKind].verb;
  return rule.effect === "deny" ? `${who} can't ${verb} ${what}` : `${who} can ${verb} ${what}`;
}

function RulesTab({ rules, loading, error, canManage }: { rules: AccessRule[]; loading: boolean; error: Error | null; canManage: boolean }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const { describe } = usePrincipalDirectory();
  const nameOf = useResourceNames();
  const visible = rules.filter((rule) => !rule.resourceKind.startsWith("knowledge_"));
  const needle = query.trim().toLowerCase();
  const filtered = visible.filter((rule) => (showExpired || !rule.expired) && (
    !needle || `${nameOf(rule.resourceKind, rule.resourceId)} ${accessResourceKindLabels[rule.resourceKind].label} ${describe(rule).label} ${rule.reason ?? ""}`.toLowerCase().includes(needle)
  ));
  const groups = useMemo(() => {
    const map = new Map<string, AccessRule[]>();
    for (const rule of filtered) {
      const key = `${rule.resourceKind}\n${rule.resourceId}`;
      map.set(key, [...(map.get(key) ?? []), rule]);
    }
    return [...map.values()];
  }, [filtered]);
  const expiredCount = visible.filter((rule) => rule.expired).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1"><DenInput icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, person or reason" aria-label="Search rules" /></div>
        {canManage && !adding ? <DenButton icon={Plus} onClick={() => setAdding(true)}>Add rule</DenButton> : null}
      </div>
      {adding ? <RuleEditor onDone={() => setAdding(false)} /> : null}
      {error ? <DenNotice message={error.message} className="mb-4" /> : null}
      {loading ? <Empty title="Loading rules…" /> : groups.length === 0 ? (
        <Empty
          title={visible.length === 0 ? "No rules yet" : "No rules match"}
          body={visible.length === 0 ? "Everything is shared the way it is today. Add a rule to keep a model to one team, or to block a tool for everyone." : undefined}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((groupRules) => <RuleGroup key={`${groupRules[0].resourceKind}:${groupRules[0].resourceId}`} rules={groupRules} canManage={canManage} />)}
        </div>
      )}
      {expiredCount > 0 ? (
        <label className="mt-4 flex items-center gap-2 text-[13px] text-gray-500">
          <input type="checkbox" checked={showExpired} onChange={(event) => setShowExpired(event.target.checked)} /> Show {expiredCount} ended {expiredCount === 1 ? "rule" : "rules"}
        </label>
      ) : null}
    </div>
  );
}

function RuleGroup({ rules, canManage }: { rules: AccessRule[]; canManage: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const nameOf = useResourceNames();
  const { error, busy, run } = useActions();
  const first = rules[0];
  const what = nameOf(first.resourceKind, first.resourceId);
  const limited = rules.some((rule) => rule.effect === "allow" && !rule.expired);
  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-5 py-3">
        <ResourceIcon kind={first.resourceKind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-gray-900">{first.resourceId === "*" ? `Every ${accessResourceKindLabels[first.resourceKind].noun}` : what}</p>
          <p className="text-[12px] text-gray-500">{accessResourceKindLabels[first.resourceKind].label}</p>
        </div>
        {limited ? <DenChip tone="info" size="sm">Only the people allowed below</DenChip> : null}
      </div>
      {error ? <DenNotice message={error} className="mx-5 mt-3" /> : null}
      <ul className="divide-y divide-gray-100">
        {rules.map((rule) => {
          const principal = describe(rule);
          const sentence = ruleSentence(rule, principal.label, what);
          return (
            <li key={rule.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${rule.expired ? "opacity-50" : ""}`}>
              {rule.effect === "allow"
                ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-label="Allowed" />
                : <Ban className="h-4 w-4 shrink-0 text-red-600" aria-label="Blocked" />}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-gray-800">{sentence}</p>
                <p className="truncate text-[12px] text-gray-500">
                  {rule.expiresAt ? (rule.expired ? "Ended" : `Ends ${relativeTime(rule.expiresAt)}`) : "No end date"}
                  {rule.reason ? ` · ${rule.reason}` : ""}
                </p>
              </div>
              {canManage ? (
                <DenButton variant="ghost" size="sm" icon={Trash2} loading={busy === rule.id} aria-label={`Remove rule: ${sentence}`} onClick={() => {
                  if (!confirm(`Remove this rule?\n\n${sentence}.`)) return;
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

function RuleEditor({ onDone }: { onDone: () => void }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const nameOf = useResourceNames();
  const { error, busy, run } = useActions();
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [resource, setResource] = useState<PickedResource | null>(null);
  const [until, setUntil] = useState("forever");
  const [reason, setReason] = useState("");
  const days = durationChoices.find((choice) => choice.value === until)?.days ?? null;
  const who = principal ? describe(principal).label : null;
  const what = resource ? nameOf(resource.kind, resource.id, resource.label) : null;
  const preview = who && what && resource
    ? effect === "allow"
      ? `${ruleSentence({ effect, resourceKind: resource.kind }, who, what)}. Everyone else loses access to it unless it is already shared with them.`
      : `${ruleSentence({ effect, resourceKind: resource.kind }, who, what)}, even if it is shared with them.`
    : null;

  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5">
      <p className="text-[15px] font-semibold text-gray-900">New rule</p>
      <p className="mb-5 mt-0.5 text-[13px] text-gray-500">Read it as a sentence: who, can or can't, what.</p>
      <div className="space-y-4">
        <Field label="Who"><PrincipalPicker value={principal} onChange={setPrincipal} /></Field>
        <DenSegmented aria-label="Effect" value={effect} onChange={setEffect} options={[{ value: "allow", label: "Can use" }, { value: "deny", label: "Can't use" }]} />
        <Field label="What"><ResourcePicker value={resource} onChange={setResource} kinds={ruleKinds} allowEvery /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="For how long">
            <DenSelect aria-label="For how long" value={until} onChange={(event) => setUntil(event.target.value)}>
              {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.days === null ? "No end date" : `For ${choice.label}`}</option>)}
            </DenSelect>
          </Field>
          <Field label="Why (saved in the audit log)">
            <DenInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Licensed for the IT team only" aria-label="Reason" />
          </Field>
        </div>
      </div>
      {preview ? (
        <p className={`mt-5 rounded-xl px-4 py-3 text-[13px] leading-5 ${effect === "deny" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{preview}</p>
      ) : null}
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      <div className="mt-5 flex gap-2">
        <DenButton disabled={!principal || !resource} loading={busy === "save"} onClick={() => principal && resource && void run("save", async () => {
          await createRule({
            ...principal,
            resourceKind: resource.kind,
            resourceId: resource.id,
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
  const nameOf = useResourceNames();
  const [member, setMember] = useState<Principal | null>(null);
  const [resource, setResource] = useState<PickedResource | null>(null);
  const [result, setResult] = useState<{ check: AccessCheck; resource: PickedResource } | null>(null);
  const { error, busy, run } = useActions();
  const { orgId } = useOrgDashboard();
  const rules = useAccessRules(orgId);
  const decided = result?.check.decision;
  const rule = decided?.ruleId ? rules.data?.find((candidate) => candidate.id === decided.ruleId) : undefined;
  const name = member ? describe(member).label : "";
  const explain = (kind: AccessResourceKind): Record<string, string> => ({
    policy: rule ? `Because of a rule: ${ruleSentence(rule, describe(rule).label, nameOf(rule.resourceKind, rule.resourceId))}${rule.reason ? ` (${rule.reason})` : ""}.` : "Because of an access rule.",
    open: `Because no rule limits this ${accessResourceKindLabels[kind].noun}, so everyone can.`,
    restricted: "Because rules keep it to other people, and it isn't shared with them directly.",
    default: "Because it isn't shared with them and no rule allows it.",
    grant: "Because it is shared with them directly.",
  });

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <p className="mb-5 text-[14px] text-gray-600">Pick a person and a resource to see whether they can use it, and which rule decides. Useful for access reviews.</p>
      <div className="space-y-4">
        <Field label="Person"><PrincipalPicker value={member} onChange={(value) => { setMember(value); setResult(null); }} only={["member"]} ariaLabel="Person" /></Field>
        <Field label="What"><ResourcePicker value={resource} onChange={(value) => { setResource(value); setResult(null); }} kinds={checkKinds} /></Field>
      </div>
      <div className="mt-5">
        <DenButton icon={Search} disabled={!member || !resource} loading={busy === "check"} onClick={() => member && resource && void run("check", async () => {
          setResult({ check: await checkAccess({ memberId: member.principalId, resourceKind: resource.kind, resourceId: resource.id }), resource });
        })}>Check</DenButton>
      </div>
      {error ? <DenNotice message={error} className="mt-4" /> : null}
      {result && decided ? (
        <div className={`mt-5 rounded-xl px-4 py-4 ${decided.allowed ? "bg-emerald-50" : "bg-red-50"}`}>
          <p className={`text-[15px] font-semibold ${decided.allowed ? "text-emerald-800" : "text-red-800"}`}>
            {name} {decided.allowed ? "can" : "can't"} {accessResourceKindLabels[result.resource.kind].verb} {nameOf(result.resource.kind, result.resource.id, result.resource.label)}
          </p>
          <p className="mt-1 text-[13px] text-gray-700">{explain(result.resource.kind)[decided.via] ?? ""}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-gray-500">Rules for any of these apply to them:</span>
            {result.check.principals.map((p) => <PrincipalChip key={`${p.kind}:${p.id}`} principal={describe({ principalKind: p.kind, principalId: p.id })} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
