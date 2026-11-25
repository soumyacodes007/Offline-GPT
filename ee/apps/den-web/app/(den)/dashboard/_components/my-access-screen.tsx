"use client";

import { FileText, Lock, Search, Send } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
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
  type KnowledgeSearchResult,
} from "./access-data";
import { ResourceIcon, ResourcePicker, useResourceNames, type PickedResource } from "./access-resources";
import { Empty, Field, useActions } from "./access-ui";

const statusCopy = {
  pending: { label: "Waiting for an admin", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
  expired: { label: "Closed, no answer", tone: "neutral" },
} as const;

const requestableKinds = ["model", "mcp_connection", "capability", "config_object", "plugin", "knowledge_document"] as const;
const isKind = (value: string | null) => accessResourceKinds.find((kind) => kind === value);

export function MyAccessScreen() {
  const params = useSearchParams();
  const linkedKind = isKind(params.get("kind"));
  const linkedId = params.get("id")?.trim();
  // Arriving from an "access denied" link: the form opens filled in for that resource.
  const linked: PickedResource | null = linkedKind && linkedId ? { kind: linkedKind, id: linkedId, label: params.get("label") ?? undefined } : null;

  return (
    <DashboardPageTemplate
      title="My access"
      description="Ask for something you can't use yet, follow your requests, and search the documents you're allowed to read."
      colors={["#10223B", "#264B73", "#4F86B8", "#B7D4EE"]}
    >
      <div>
        <RequestForm linked={linked} />
        <MyRequests />
        <KnowledgeSearch />
      </div>
    </DashboardPageTemplate>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="border-t border-gray-100 pt-8 first:border-t-0 first:pt-0 [&:not(:last-child)]:pb-8">
      <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
      {description ? <p className="mt-0.5 text-[13px] text-gray-500">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function RequestForm({ linked }: { linked: PickedResource | null }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const mine = useAccessRequests(orgId, "mine");
  const nameOf = useResourceNames();
  const { error, busy, run } = useActions();
  const [resource, setResource] = useState<PickedResource | null>(linked);
  const [purpose, setPurpose] = useState("");
  const [days, setDays] = useState("7");
  const [sentFor, setSentFor] = useState<string | null>(null);
  const chosen = durationChoices.find((choice) => choice.value === days) ?? durationChoices[1];
  const name = resource ? nameOf(resource.kind, resource.id, resource.label) : null;
  const alreadyWaiting = resource
    ? (mine.data ?? []).find((request) => request.status === "pending" && request.resourceKind === resource.kind && request.resourceId === resource.id)
    : undefined;
  const fromLink = Boolean(linked && resource && linked.kind === resource.kind && linked.id === resource.id);

  return (
    <Section
      title={fromLink && name ? `You don't have access to ${name} yet` : "Ask for access"}
      description={fromLink ? "Tell an admin why you need it. They'll see your reason and approve or decline." : "Choose what you need and say why. An admin sees your reason and answers here."}
    >
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="space-y-4">
          {fromLink && resource && name ? (
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-4 py-3">
              <ResourceIcon kind={resource.kind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-gray-900">{name}</p>
                <p className="text-[12px] text-gray-500">{accessResourceKindLabels[resource.kind].label}</p>
              </div>
              <button type="button" className="text-[12px] font-medium text-gray-500 hover:text-gray-800" onClick={() => setResource(null)}>Ask for something else</button>
            </div>
          ) : (
            <Field label="What do you need?"><ResourcePicker value={resource} onChange={setResource} kinds={requestableKinds} /></Field>
          )}
          {alreadyWaiting ? (
            <DenNotice tone="info" message={`You already asked for this ${relativeTime(alreadyWaiting.createdAt)}. It's waiting for an admin; the answer will show below.`} />
          ) : (
            <>
              <Field label="Why do you need it?">
                <DenTextarea rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="e.g. I'm reviewing the plant maintenance code this week" aria-label="Why do you need it?" />
              </Field>
              <div className="w-full sm:w-[220px]">
                <Field label="For how long">
                  <DenSelect aria-label="For how long" value={days} onChange={(event) => setDays(event.target.value)}>
                    {durationChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.days === null ? "Until it's removed" : choice.label}</option>)}
                  </DenSelect>
                </Field>
              </div>
            </>
          )}
        </div>
        {error ? <DenNotice message={error} className="mt-4" /> : null}
        {sentFor && !resource ? <DenNotice tone="neutral" message={`Request for ${sentFor} sent. The answer will show below.`} className="mt-4" /> : null}
        {!alreadyWaiting ? (
          <div className="mt-5 flex items-center gap-3">
            <DenButton icon={Send} disabled={!resource || purpose.trim().length < 3} loading={busy === "send"} onClick={() => resource && void run("send", async () => {
              await createAccessRequest({ resourceKind: resource.kind, resourceId: resource.id, ...(name ? { resourceLabel: name } : {}), purpose: purpose.trim(), requestedDays: chosen.days });
              setSentFor(name);
              setPurpose("");
              setResource(null);
              await invalidate();
            })}>Send request</DenButton>
            <p className="text-[12px] text-gray-400">Requests close after 7 days without an answer.</p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function MyRequests() {
  const { orgId } = useOrgDashboard();
  const requests = useAccessRequests(orgId, "mine");
  const invalidate = useInvalidateAccess(orgId);
  const nameOf = useResourceNames();
  const { error, busy, run } = useActions();
  const list = requests.data ?? [];
  return (
    <Section title="Your requests">
      {requests.error ? <DenNotice message={requests.error.message} /> : null}
      {error ? <DenNotice message={error} className="mb-3" /> : null}
      {requests.isLoading ? <Empty title="Loading…" /> : list.length === 0 ? (
        <p className="text-[13px] text-gray-500">You haven't asked for anything yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
          {list.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <ResourceIcon kind={request.resourceKind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-gray-900">{nameOf(request.resourceKind, request.resourceId, request.resourceLabel)}</p>
                <p className="truncate text-[12px] text-gray-500">
                  {accessResourceKindLabels[request.resourceKind].label} · asked {relativeTime(request.createdAt)} for {durationLabel(request.requestedDays).toLowerCase()}
                  {request.decisionNote ? ` · “${request.decisionNote}”` : ""}
                </p>
              </div>
              <DenChip tone={statusCopy[request.status].tone} size="sm">{statusCopy[request.status].label}</DenChip>
              {request.status === "pending" ? (
                <DenButton variant="ghost" size="sm" loading={busy === request.id} onClick={() => void run(request.id, async () => { await cancelAccessRequest(request.id); await invalidate(); })}>Withdraw</DenButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function KnowledgeSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);
  const { error, busy, run } = useActions();
  return (
    <Section title="Search what you can read" description="The same documents OfflineGPT can use when it answers you. Anything you're not allowed to read is left out.">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (query.trim()) void run("search", async () => setResults(await searchKnowledge(query.trim()))); }}>
        <div className="flex-1"><DenInput icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. leave policy for contract staff" aria-label="Search the knowledge base" /></div>
        <DenButton type="submit" variant="secondary" loading={busy === "search"} disabled={!query.trim()}>Search</DenButton>
      </form>
      {error ? <DenNotice message={error} className="mt-3" /> : null}
      {results ? (
        results.length === 0 ? (
          <p className="mt-4 text-[13px] text-gray-500">Nothing you can read matches. If you expected a document, ask for access above.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {results.map((result) => (
              <li key={result.chunkId} className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  <p className="text-[13px] font-semibold text-gray-900">{result.documentTitle}{result.heading ? <span className="font-normal text-gray-500"> · {result.heading}</span> : null}</p>
                  {result.sensitivity === "sensitive" ? <DenChip tone="warning" size="sm">Sensitive · reads are logged</DenChip> : null}
                  {result.sensitivity === "restricted" ? <DenChip tone="danger" size="sm" icon={Lock}>Restricted</DenChip> : null}
                </div>
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] leading-6 text-gray-700">{result.text}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Section>
  );
}
