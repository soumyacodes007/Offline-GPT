"use client";

import { ArrowLeft, Ban, CheckCircle2, FileText, Lock, Plus, Trash2, Upload, X } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  createKnowledgeDocument,
  createRule,
  labelKnowledgeChunk,
  relativeTime,
  removeKnowledgeDocument,
  removeRule,
  sensitivities,
  useInvalidateAccess,
  useKnowledgeDocument,
  useKnowledgeDocuments,
  type DocumentRule,
  type KnowledgeChunk,
  type Principal,
  type Sensitivity,
} from "./access-data";
import { PrincipalChip, PrincipalPicker, usePrincipalDirectory } from "./access-principals";
import { Empty, Field, useActions } from "./access-ui";

const sensitivityCopy: Record<Sensitivity, { label: string; tone: "neutral" | "warning" | "danger"; help: string }> = {
  ordinary: { label: "Ordinary", tone: "neutral", help: "Everyone who can read the document" },
  sensitive: { label: "Sensitive", tone: "warning", help: "Same readers; every read is logged" },
  restricted: { label: "Restricted", tone: "danger", help: "Only people named on this section" },
};

export function KnowledgeAdmin({ canManage }: { canManage: boolean }) {
  const { orgId } = useOrgDashboard();
  const documents = useKnowledgeDocuments(orgId);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { describe } = usePrincipalDirectory();

  if (openId) return <DocumentDetail documentId={openId} canManage={canManage} onBack={() => setOpenId(null)} />;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-[13px] text-gray-500">The agent searches only the sections each person may read. Documents are private until you choose who can read them.</p>
        <DenButton icon={Plus} disabled={!canManage} onClick={() => setAdding(true)}>Add document</DenButton>
      </div>
      {adding ? <AddDocument onDone={() => setAdding(false)} /> : null}
      {documents.error ? <DenNotice message={documents.error.message} className="mb-4" /> : null}
      {documents.isLoading ? <Empty title="Loading knowledge…" /> : (documents.data ?? []).length === 0 ? (
        <Empty title="No documents yet" body="Add policies, manuals or procedures. Each heading becomes a section you can label or limit to certain people." />
      ) : (
        <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
          {(documents.data ?? []).map((doc) => (
            <button key={doc.id} type="button" onClick={() => setOpenId(doc.id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left hover:bg-gray-50">
              <FileText className="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-gray-900">{doc.title}</p>
                <p className="text-[12px] text-gray-500">
                  {doc.chunkCount} sections · added {relativeTime(doc.createdAt)}
                  {doc.chunksWithRules ? ` · ${doc.chunksWithRules} with their own rules` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(doc.audience ?? []).slice(0, 3).map((rule) => <PrincipalChip key={rule.id} principal={describe(rule)} />)}
                {(doc.audience ?? []).length > 3 ? <DenChip>+{(doc.audience ?? []).length - 3}</DenChip> : null}
                {doc.sensitivity?.sensitive ? <DenChip tone="warning">{doc.sensitivity.sensitive} sensitive</DenChip> : null}
                {doc.sensitivity?.restricted ? <DenChip tone="danger" icon={Lock}>{doc.sensitivity.restricted} restricted</DenChip> : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddDocument({ onDone }: { onDone: () => void }) {
  const { orgId, orgContext } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [sourceName, setSourceName] = useState<string | undefined>();
  const [sensitivity, setSensitivity] = useState<Sensitivity>("ordinary");
  const everyone: Principal | null = orgContext ? { principalKind: "org", principalId: orgContext.organization.id } : null;
  const [audience, setAudience] = useState<Principal[]>(everyone ? [everyone] : []);
  const [picking, setPicking] = useState<Principal | null>(null);

  const readFile = async (file: File) => {
    setText(await file.text());
    setSourceName(file.name);
    if (!title) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
  };

  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5">
      <p className="mb-4 text-[15px] font-semibold text-gray-900">Add a document</p>
      <div className="space-y-4">
        <Field label="Title"><DenInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Leave and attendance policy" aria-label="Title" /></Field>
        <Field label="Content (Markdown or plain text; each heading starts a section)">
          <DenTextarea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste the document, or upload a .md or .txt file" aria-label="Content" />
        </Field>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium text-[#1E3A5F]">
          <Upload className="h-4 w-4" aria-hidden="true" /> Upload a file
          <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />
          {sourceName ? <span className="text-gray-500">· {sourceName}</span> : null}
        </label>
        <Field label="Who can read it">
          <div className="flex flex-wrap items-center gap-1.5">
            {audience.map((principal) => (
              <span key={`${principal.principalKind}:${principal.principalId}`} className="inline-flex items-center gap-1">
                <PrincipalChip principal={describe(principal)} />
                <button type="button" aria-label="Remove" className="text-gray-400 hover:text-gray-700" onClick={() => setAudience(audience.filter((p) => p !== principal))}><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            {audience.length === 0 ? <span className="text-[13px] text-amber-700">Nobody yet — add at least one person, team or role.</span> : null}
          </div>
          <div className="mt-2 flex gap-2">
            <div className="flex-1"><PrincipalPicker value={picking} onChange={setPicking} ariaLabel="Add reader" /></div>
            <DenButton variant="secondary" disabled={!picking} onClick={() => {
              if (picking && !audience.some((p) => p.principalKind === picking.principalKind && p.principalId === picking.principalId)) setAudience([...audience, picking]);
              setPicking(null);
            }}>Add</DenButton>
          </div>
        </Field>
        <Field label="Label for every section (change single sections later)">
          <DenSegmented aria-label="Label" value={sensitivity} onChange={setSensitivity} options={sensitivities.map((value) => ({ value, label: sensitivityCopy[value].label }))} />
          <p className="mt-1.5 text-[12px] text-gray-500">{sensitivityCopy[sensitivity].help}</p>
        </Field>
      </div>
      {error ? <DenNotice message={error} className="mt-4" /> : null}
      <div className="mt-4 flex gap-2">
        <DenButton disabled={!title.trim() || !text.trim() || audience.length === 0} loading={busy === "add"} onClick={() => void run("add", async () => {
          await createKnowledgeDocument({ title: title.trim(), text, ...(sourceName ? { sourceName } : {}), audience, sensitivity });
          await invalidate();
          onDone();
        })}>Add document</DenButton>
        <DenButton variant="ghost" onClick={onDone}>Cancel</DenButton>
      </div>
    </div>
  );
}

function RuleList({ rules, canManage, onRemoved }: { rules: DocumentRule[]; canManage: boolean; onRemoved: () => Promise<void> }) {
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {rules.map((rule) => (
        <span key={rule.id} className="inline-flex items-center gap-1">
          {rule.effect === "deny" ? <Ban className="h-3.5 w-3.5 text-red-600" aria-label="Denied" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Allowed" />}
          <PrincipalChip principal={describe(rule)} />
          {canManage ? (
            <button type="button" aria-label="Remove rule" disabled={busy === rule.id} className="text-gray-400 hover:text-gray-700" onClick={() => void run(rule.id, async () => { await removeRule(rule.id); await onRemoved(); })}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      ))}
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </div>
  );
}

function AddRuleInline({ resourceKind, resourceId, onAdded, allowDeny = true }: { resourceKind: "knowledge_document" | "knowledge_chunk"; resourceId: string; onAdded: () => Promise<void>; allowDeny?: boolean }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const { error, busy, run } = useActions();
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {allowDeny ? <DenSegmented aria-label="Effect" value={effect} onChange={setEffect} options={[{ value: "allow", label: "Only these can read" }, { value: "deny", label: "Hide from" }]} /> : null}
        <div className="min-w-[240px] flex-1"><PrincipalPicker value={principal} onChange={setPrincipal} ariaLabel="Person, team or role" /></div>
        <DenButton size="sm" variant="secondary" disabled={!principal} loading={busy === "add"} onClick={() => principal && void run("add", async () => {
          await createRule({ ...principal, resourceKind, resourceId, effect });
          setPrincipal(null);
          await onAdded();
        })}>Add</DenButton>
      </div>
      {error ? <DenNotice message={error} className="mt-2" /> : null}
    </div>
  );
}

function DocumentDetail({ documentId, canManage, onBack }: { documentId: string; canManage: boolean; onBack: () => void }) {
  const { orgId } = useOrgDashboard();
  const detail = useKnowledgeDocument(orgId, documentId);
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  const doc = detail.data?.document;

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All documents
      </button>
      {detail.error ? <DenNotice message={detail.error.message} /> : null}
      {detail.isLoading || !doc ? <Empty title="Opening…" /> : (
        <>
          <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[17px] font-semibold text-gray-900">{doc.title}</p>
                <p className="text-[12px] text-gray-500">{doc.sourceName ? `${doc.sourceName} · ` : ""}added {relativeTime(doc.createdAt)} · {detail.data?.chunks.length} sections</p>
              </div>
              {canManage ? (
                <DenButton variant="destructive" size="sm" icon={Trash2} loading={busy === "remove"} onClick={() => {
                  if (!confirm(`Remove "${doc.title}"? Its text is deleted and the agent can no longer find it.`)) return;
                  void run("remove", async () => { await removeKnowledgeDocument(documentId); await invalidate(); onBack(); });
                }}>Remove</DenButton>
              ) : null}
            </div>
            <p className="mt-4 mb-1.5 text-[12px] font-medium text-gray-600">Who can read this document</p>
            <RuleList rules={doc.audience ?? []} canManage={canManage} onRemoved={invalidate} />
            {(doc.audience ?? []).every((rule) => rule.effect !== "allow") ? <p className="mt-1 text-[12px] text-amber-700">Nobody can read it until you add someone.</p> : null}
            {canManage ? <AddRuleInline resourceKind="knowledge_document" resourceId={documentId} onAdded={invalidate} /> : null}
            {error ? <DenNotice message={error} className="mt-3" /> : null}
          </div>
          <div className="space-y-3">
            {(detail.data?.chunks ?? []).map((chunk) => <ChunkCard key={chunk.id} chunk={chunk} canManage={canManage} />)}
          </div>
        </>
      )}
    </div>
  );
}

function ChunkCard({ chunk, canManage }: { chunk: KnowledgeChunk; canManage: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  const [expanded, setExpanded] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const rules = chunk.rules ?? [];
  const copy = sensitivityCopy[chunk.sensitivity];
  return (
    <div className={`rounded-2xl border bg-white p-5 ${chunk.sensitivity === "restricted" ? "border-red-200" : "border-gray-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[14px] font-semibold text-gray-900">
          <span className="mr-2 text-gray-400">§{chunk.ordinal + 1}</span>{chunk.heading ?? "Untitled section"}
        </p>
        <div className="flex items-center gap-2">
          {canManage ? (
            <div className="w-[150px]">
              <DenSelect aria-label="Label" value={chunk.sensitivity} disabled={busy === "label"} onChange={(event) => {
                const next = sensitivities.find((value) => value === event.target.value);
                if (next && next !== chunk.sensitivity) void run("label", async () => { await labelKnowledgeChunk(chunk.id, next); await invalidate(); });
              }}>
                {sensitivities.map((value) => <option key={value} value={value}>{sensitivityCopy[value].label}</option>)}
              </DenSelect>
            </div>
          ) : <DenChip tone={copy.tone}>{copy.label}</DenChip>}
        </div>
      </div>
      <p className={`mt-2 whitespace-pre-wrap text-[13px] leading-6 text-gray-700 ${expanded ? "" : "line-clamp-3"}`}>{chunk.text}</p>
      <button type="button" className="mt-1 text-[12px] font-medium text-gray-500 hover:text-gray-800" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show all"}</button>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className="text-[12px] text-gray-500">
          {chunk.sensitivity === "restricted"
            ? rules.some((rule) => rule.effect === "allow") ? "Only the people below can read this section." : "Restricted: nobody can read this section until you name someone below."
            : rules.some((rule) => rule.effect === "allow") ? "Limited to the people below (they must also be able to read the document)." : rules.length ? "Everyone who can read the document, except:" : copy.help + "."}
        </p>
        {rules.length ? <div className="mt-1.5"><RuleList rules={rules} canManage={canManage} onRemoved={invalidate} /></div> : null}
        {canManage ? (
          editingRules
            ? <AddRuleInline resourceKind="knowledge_chunk" resourceId={chunk.id} onAdded={async () => { await invalidate(); setEditingRules(false); }} />
            : <button type="button" className="mt-1.5 text-[12px] font-medium text-[#1E3A5F]" onClick={() => setEditingRules(true)}>Change who can read this section</button>
        ) : null}
        {error ? <DenNotice message={error} className="mt-2" /> : null}
      </div>
    </div>
  );
}
