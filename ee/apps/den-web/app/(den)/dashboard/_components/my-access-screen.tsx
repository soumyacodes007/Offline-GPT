"use client";

import { FileText, Lock, Search, Send } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  accessResourceKindLabels,
  accessResourceKinds,
  cancelAccessRequest,
  createAccessRequest,
  durationChoices,
  durationLabel,
  relativeTime,
  searchKnowledge,
  useAccessRequests,
  useInvalidateAccess,
  type AccessResourceKind,
  type KnowledgeSearchResult,
} from "./access-data";
import { Empty, Field, useActions } from "./access-ui";

const statusCopy = {
  pending: { label: "Waiting for an admin", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired — nobody answered", tone: "neutral" },
} as const;

const requestableKinds = accessResourceKinds.filter((kind) => kind !== "knowledge_chunk");

export function MyAccessScreen() {
  return (
    <DashboardPageTemplate
      title="Knowledge & access"
      description="Search what you're allowed to read, ask for access you don't have, and follow your requests."
      colors={["#10223B", "#264B73", "#4F86B8", "#B7D4EE"]}
    >
      <KnowledgeSearch />
      <RequestForm />
      <MyRequests />
    </DashboardPageTemplate>
  );
}

function KnowledgeSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);
  const { error, busy, run } = useActions();
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[15px] font-semibold text-gray-900">Search the knowledge base</h2>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (query.trim()) void run("search", async () => setResults(await searchKnowledge(query.trim()))); }}>
        <div className="flex-1"><DenInput icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. leave policy for contract staff" aria-label="Search the knowledge base" /></div>
        <DenButton type="submit" loading={busy === "search"} disabled={!query.trim()}>Search</DenButton>
      </form>
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      {results ? (
        results.length === 0 ? (
          <p className="mt-4 text-[13px] text-gray-500">Nothing you can read matches. If you expected a document, ask for access below.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {results.map((result) => (
              <li key={result.chunkId} className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  <p className="text-[13px] font-semibold text-gray-900">{result.documentTitle}{result.heading ? <span className="font-normal text-gray-500"> · {result.heading}</span> : null}</p>
                  {result.sensitivity === "sensitive" ? <DenChip tone="warning">Sensitive — reads are logged</DenChip> : null}
                  {result.sensitivity === "restricted" ? <DenChip tone="danger" icon={Lock}>Restricted</DenChip> : null}
                </div>
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] leading-6 text-gray-700">{result.text}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function RequestForm() {
  const params = useSearchParams();
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  const initialKind = requestableKinds.find((kind) => kind === params.get("kind")) ?? "model";
  const [kind, setKind] = useState<AccessResourceKind>(initialKind);
  const [resourceId, setResourceId] = useState(params.get("id") ?? "");
  const [label, setLabel] = useState(params.get("label") ?? "");
  const [purpose, setPurpose] = useState("");
  const [days, setDays] = useState("7");
  const [sent, setSent] = useState(false);
  const chosen = durationChoices.find((choice) => choice.value === days) ?? durationChoices[1];

  return (
    <section className="mb-8 rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="mb-1 text-[15px] font-semibold text-gray-900">Request access</h2>
      <p className="mb-4 text-[13px] text-gray-500">An owner or super-admin will see your reason and approve or decline. Requests expire after 7 days.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What">
          <DenSelect aria-label="What" value={kind} onChange={(event) => setKind(requestableKinds.find((candidate) => candidate === event.target.value) ?? "model")}>
            {requestableKinds.map((candidate) => <option key={candidate} value={candidate}>{accessResourceKindLabels[candidate].label}</option>)}
          </DenSelect>
        </Field>
        <Field label="Which"><DenInput value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder={accessResourceKindLabels[kind].hint} aria-label="Which" /></Field>
        <Field label="Name (helps the approver)"><DenInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Coder model" aria-label="Name" /></Field>
        <Field label="For how long">
          <DenSelect aria-label="For how long" value={days} onChange={(event) => setDays(event.target.value)}>
            {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </DenSelect>
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Why do you need it?">
          <DenTextarea rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="e.g. I'm reviewing the plant maintenance code this week" aria-label="Why do you need it?" />
        </Field>
      </div>
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      {sent ? <DenNotice tone="neutral" message="Request sent. You'll see the answer below." className="mt-3" /> : null}
      <div className="mt-4">
        <DenButton icon={Send} disabled={!resourceId.trim() || purpose.trim().length < 3} loading={busy === "send"} onClick={() => void run("send", async () => {
          await createAccessRequest({ resourceKind: kind, resourceId: resourceId.trim(), ...(label.trim() ? { resourceLabel: label.trim() } : {}), purpose: purpose.trim(), requestedDays: chosen.days });
          setPurpose("");
          setSent(true);
          await invalidate();
        })}>Send request</DenButton>
      </div>
    </section>
  );
}

function MyRequests() {
  const { orgId } = useOrgDashboard();
  const requests = useAccessRequests(orgId, "mine");
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  return (
    <section>
      <h2 className="mb-3 text-[15px] font-semibold text-gray-900">Your requests</h2>
      {requests.error ? <DenNotice message={requests.error.message} /> : null}
      {error ? <DenNotice message={error} className="mb-3" /> : null}
      {requests.isLoading ? <Empty title="Loading…" /> : (requests.data ?? []).length === 0 ? <Empty title="No requests yet" /> : (
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
          {(requests.data ?? []).map((request) => (
            <li key={request.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-gray-900">{request.resourceLabel ?? request.resourceId} <span className="font-normal text-gray-500">· {accessResourceKindLabels[request.resourceKind].label}</span></p>
                <p className="truncate text-[12px] text-gray-500">
                  Asked {relativeTime(request.createdAt)} for {durationLabel(request.requestedDays)}
                  {request.decisionNote ? ` · “${request.decisionNote}”` : ""}
                </p>
              </div>
              <DenChip tone={statusCopy[request.status].tone} size="sm">{statusCopy[request.status].label}</DenChip>
              {request.status === "pending" ? (
                <DenButton variant="ghost" size="sm" loading={busy === request.id} onClick={() => void run(request.id, async () => { await cancelAccessRequest(request.id); await invalidate(); })}>Cancel</DenButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
