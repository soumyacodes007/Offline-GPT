"use client";

import { ArrowLeft, Ban, CheckCircle2, FileText, Lock, Plus, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { getKnowledgeRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  createKnowledgeDocument,
  createRule,
  extractKnowledgeFile,
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
  type KnowledgeSourceMime,
  type Principal,
  type Sensitivity,
} from "./access-data";
import { PrincipalChip, PrincipalPicker, usePrincipalDirectory } from "./access-principals";
import { Empty, Field, useActions } from "./access-ui";

const sensitivityCopy: Record<Sensitivity, { label: string; tone: "neutral" | "warning" | "danger"; help: string }> = {
  ordinary: { label: "Normal", tone: "neutral", help: "Everyone who can read the document can read it." },
  sensitive: { label: "Sensitive", tone: "warning", help: "Same readers, but every time someone reads it, it is logged." },
  restricted: { label: "Restricted", tone: "danger", help: "Only people you name on the section itself can read it." },
};

const colors: [string, string, string, string] = ["#0F172A", "#1E3A5F", "#3B6EA8", "#9CC3E6"];

function useCanManage() {
  const { orgContext } = useOrgDashboard();
  return getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles).canManageSettings;
}

/* ───────────────────────────── Document list ───────────────────────────── */

export function KnowledgeScreen() {
  const { orgId, activeOrg } = useOrgDashboard();
  const canManage = useCanManage();
  const documents = useKnowledgeDocuments(orgId);
  const [adding, setAdding] = useState(false);
  const { describe } = usePrincipalDirectory();
  const list = documents.data ?? [];

  return (
    <DashboardPageTemplate
      title="Knowledge"
      description="Policies, manuals and procedures OfflineGPT can use to answer. Each person only gets answers from the parts they're allowed to read."
      colors={colors}
    >
      {!canManage ? <DenNotice tone="info" className="mb-6" message="You can look, but only owners and super-admins can add documents or change who reads them." /> : null}
      {adding ? <AddDocument onDone={() => setAdding(false)} /> : null}
      {!adding && canManage && list.length > 0 ? (
        <div className="mb-4 flex justify-end"><DenButton icon={Plus} onClick={() => setAdding(true)}>Add document</DenButton></div>
      ) : null}
      {documents.error ? <DenNotice message={documents.error.message} className="mb-4" /> : null}
      {documents.isLoading ? <Empty title="Loading…" /> : list.length === 0 && !adding ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <FileText className="mx-auto h-6 w-6 text-gray-400" aria-hidden="true" />
          <p className="mt-3 text-[15px] font-semibold text-gray-900">No documents yet</p>
          <p className="mx-auto mt-1.5 max-w-[460px] text-[13px] leading-6 text-gray-500">
            Upload a PDF or Word file. Each page or heading becomes a section you can mark sensitive or keep to certain people.
          </p>
          {canManage ? <DenButton className="mt-5" icon={Upload} onClick={() => setAdding(true)}>Add your first document</DenButton> : null}
        </div>
      ) : list.length > 0 ? (
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
          {list.map((doc) => (
            <li key={doc.id}>
              <Link href={getKnowledgeRoute(activeOrg?.slug, doc.id)} className="flex flex-wrap items-center gap-3 px-5 py-4 hover:bg-gray-50">
                <FileText className="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-gray-900">{doc.title}</p>
                  <p className="text-[12px] text-gray-500">
                    {doc.chunkCount} {doc.chunkCount === 1 ? "section" : "sections"} · added {relativeTime(doc.createdAt)}
                    {doc.chunksWithRules ? ` · ${doc.chunksWithRules} with their own readers` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(doc.audience ?? []).filter((rule) => rule.effect === "allow").slice(0, 2).map((rule) => <PrincipalChip key={rule.id} principal={describe(rule)} />)}
                  {(doc.audience ?? []).filter((rule) => rule.effect === "allow").length > 2 ? <DenChip size="sm">+{(doc.audience ?? []).filter((rule) => rule.effect === "allow").length - 2}</DenChip> : null}
                  {doc.sensitivity?.sensitive ? <DenChip tone="warning" size="sm">{doc.sensitivity.sensitive} sensitive</DenChip> : null}
                  {doc.sensitivity?.restricted ? <DenChip tone="danger" size="sm" icon={Lock}>{doc.sensitivity.restricted} restricted</DenChip> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </DashboardPageTemplate>
  );
}

function AddDocument({ onDone }: { onDone: () => void }) {
  const { orgId, orgContext } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState<{ name: string; mimeType: KnowledgeSourceMime } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("ordinary");
  const everyone: Principal | null = orgContext ? { principalKind: "org", principalId: orgContext.organization.id } : null;
  const [audience, setAudience] = useState<Principal[]>(everyone ? [everyone] : []);
  const [picking, setPicking] = useState<Principal | null>(null);
  const sections = text.trim() ? Math.max(1, (text.match(/^#{1,6}\s+\S/gm) ?? []).length) : 0;
  const hasText = Boolean(text.trim());

  const readFile = (file: File) => void run("read", async () => {
    const extracted = await extractKnowledgeFile(file);
    setText(extracted.text);
    setSource({ name: extracted.sourceName, mimeType: extracted.mimeType });
    if (!title.trim()) setTitle(extracted.title);
  });

  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-gray-900">Add a document</p>
          <p className="mt-0.5 text-[13px] text-gray-500">The file is read here, on your own servers. Nothing is sent anywhere else.</p>
        </div>
        <button type="button" aria-label="Close" className="text-gray-400 hover:text-gray-700" onClick={onDone}><X className="h-4 w-4" /></button>
      </div>

      <div className="space-y-5">
        {!hasText && !pasting ? (
          <div
            className="rounded-xl border border-dashed border-gray-300 px-6 py-8 text-center"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }}
          >
            <Upload className="mx-auto h-5 w-5 text-gray-400" aria-hidden="true" />
            <p className="mt-2 text-[14px] font-medium text-gray-900">{busy === "read" ? "Reading the file…" : "Drop a file here"}</p>
            <p className="mt-0.5 text-[12px] text-gray-500">PDF, Word (.docx), Markdown or text · up to 25 MB</p>
            <div className="mt-4 flex justify-center gap-2">
              <DenButton variant="secondary" loading={busy === "read"} onClick={() => fileInput.current?.click()}>Choose file</DenButton>
              <DenButton variant="ghost" onClick={() => setPasting(true)}>Paste text instead</DenButton>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              className="hidden"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); event.target.value = ""; }}
            />
          </div>
        ) : (
          <>
            <Field label="Title"><DenInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Leave and attendance policy" aria-label="Title" /></Field>
            <Field label={source ? `Text from ${source.name} · ${sections} ${sections === 1 ? "section" : "sections"}` : "Text"}>
              <DenTextarea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste the document. Lines starting with # begin a new section." aria-label="Content" />
              <p className="mt-1.5 text-[12px] text-gray-500">Check it reads correctly. Each page or heading is a section you can label or restrict after adding.</p>
            </Field>
          </>
        )}

        <Field label="Who can read it">
          <div className="flex flex-wrap items-center gap-1.5">
            {audience.map((principal) => (
              <span key={`${principal.principalKind}:${principal.principalId}`} className="inline-flex items-center gap-1">
                <PrincipalChip principal={describe(principal)} />
                <button type="button" aria-label={`Remove ${describe(principal).label}`} className="text-gray-400 hover:text-gray-700" onClick={() => setAudience(audience.filter((p) => p !== principal))}><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            {audience.length === 0 ? <span className="text-[13px] text-amber-700">Nobody yet. Add at least one person, team or role.</span> : null}
          </div>
          <div className="mt-2 flex gap-2">
            <div className="flex-1"><PrincipalPicker value={picking} onChange={setPicking} ariaLabel="Add reader" /></div>
            <DenButton variant="secondary" disabled={!picking} onClick={() => {
              if (picking && !audience.some((p) => p.principalKind === picking.principalKind && p.principalId === picking.principalId)) setAudience([...audience, picking]);
              setPicking(null);
            }}>Add</DenButton>
          </div>
        </Field>

        <Field label="How careful to be">
          <DenSegmented aria-label="Label" value={sensitivity} onChange={setSensitivity} options={sensitivities.map((value) => ({ value, label: sensitivityCopy[value].label }))} />
          <p className="mt-1.5 text-[12px] text-gray-500">{sensitivityCopy[sensitivity].help} You can change single sections later.</p>
        </Field>
      </div>
      {error ? <DenNotice message={error} className="mt-4" /> : null}
      <div className="mt-5 flex gap-2">
        <DenButton disabled={!title.trim() || !hasText || audience.length === 0} loading={busy === "add"} onClick={() => void run("add", async () => {
          await createKnowledgeDocument({ title: title.trim(), text, ...(source ? { sourceName: source.name, mimeType: source.mimeType } : {}), audience, sensitivity });
          await invalidate();
          onDone();
        })}>Add document</DenButton>
        <DenButton variant="ghost" onClick={onDone}>Cancel</DenButton>
      </div>
    </div>
  );
}

/* ───────────────────────────── One document ───────────────────────────── */

function RuleList({ rules, canManage, onRemoved }: { rules: DocumentRule[]; canManage: boolean; onRemoved: () => Promise<void> }) {
  const { describe } = usePrincipalDirectory();
  const { error, busy, run } = useActions();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {rules.map((rule) => (
        <span key={rule.id} className="inline-flex items-center gap-1">
          {rule.effect === "deny" ? <Ban className="h-3.5 w-3.5 text-red-600" aria-label="Hidden from" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Can read" />}
          <PrincipalChip principal={describe(rule)} />
          {canManage ? (
            <button type="button" aria-label={`Remove ${describe(rule).label}`} disabled={busy === rule.id} className="text-gray-400 hover:text-gray-700" onClick={() => void run(rule.id, async () => { await removeRule(rule.id); await onRemoved(); })}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      ))}
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </div>
  );
}

function AddReader({ resourceKind, resourceId, onAdded }: { resourceKind: "knowledge_document" | "knowledge_chunk"; resourceId: string; onAdded: () => Promise<void> }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const { error, busy, run } = useActions();
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <DenSegmented aria-label="Effect" value={effect} onChange={setEffect} options={[{ value: "allow", label: "Can read" }, { value: "deny", label: "Hide from" }]} />
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

export function KnowledgeDocumentScreen({ documentId }: { documentId: string }) {
  const { orgId, activeOrg } = useOrgDashboard();
  const router = useRouter();
  const canManage = useCanManage();
  const detail = useKnowledgeDocument(orgId, documentId);
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  const doc = detail.data?.document;
  const chunks = detail.data?.chunks ?? [];
  const nobody = doc ? (doc.audience ?? []).every((rule) => rule.effect !== "allow") : false;

  return (
    <DashboardPageTemplate
      title={doc?.title ?? "Document"}
      description={doc ? `${doc.sourceName ? `${doc.sourceName} · ` : ""}added ${relativeTime(doc.createdAt)} · ${chunks.length} ${chunks.length === 1 ? "section" : "sections"}` : "Opening…"}
      colors={colors}
    >
      <Link href={getKnowledgeRoute(activeOrg?.slug)} className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All documents
      </Link>
      {detail.error ? <DenNotice message={detail.error.message} /> : null}
      {detail.isLoading || !doc ? (detail.error ? null : <Empty title="Opening…" />) : (
        <>
          <section className="mb-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold text-gray-900">Who can read this document</h2>
                <p className="mt-0.5 text-[13px] text-gray-500">Only these people get answers from it. Sections can narrow this further.</p>
              </div>
              {canManage ? (
                <DenButton variant="ghost" size="sm" icon={Trash2} loading={busy === "remove"} onClick={() => {
                  if (!confirm(`Remove "${doc.title}"? Its text is deleted and OfflineGPT can no longer use it.`)) return;
                  void run("remove", async () => { await removeKnowledgeDocument(documentId); await invalidate(); router.push(getKnowledgeRoute(activeOrg?.slug)); });
                }}>Remove document</DenButton>
              ) : null}
            </div>
            <div className="mt-3"><RuleList rules={doc.audience ?? []} canManage={canManage} onRemoved={invalidate} /></div>
            {nobody ? <p className="mt-2 text-[12px] text-amber-700">Nobody can read it until you add someone.</p> : null}
            {canManage ? <AddReader resourceKind="knowledge_document" resourceId={documentId} onAdded={invalidate} /> : null}
            {error ? <DenNotice message={error} className="mt-3" /> : null}
          </section>
          <section className="border-t border-gray-100 pt-8">
            <h2 className="text-[15px] font-semibold text-gray-900">Sections</h2>
            <p className="mb-4 mt-0.5 text-[13px] text-gray-500">Mark a section sensitive to log every read, or restricted to keep it to the people you name.</p>
            {detail.data?.hiddenCount ? <DenNotice tone="info" className="mb-4" message={`${detail.data.hiddenCount} sections are hidden from you.`} /> : null}
            <div className="space-y-3">
              {chunks.map((chunk) => <SectionCard key={chunk.id} chunk={chunk} canManage={canManage} />)}
            </div>
          </section>
        </>
      )}
    </DashboardPageTemplate>
  );
}

function SectionCard({ chunk, canManage }: { chunk: KnowledgeChunk; canManage: boolean }) {
  const { orgId } = useOrgDashboard();
  const invalidate = useInvalidateAccess(orgId);
  const { error, busy, run } = useActions();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const rules = chunk.rules ?? [];
  const copy = sensitivityCopy[chunk.sensitivity];
  const limited = rules.some((rule) => rule.effect === "allow");
  const readers = chunk.sensitivity === "restricted"
    ? limited ? "Only the people below can read this section." : "Restricted: nobody can read this section until you name someone."
    : limited ? "Only the people below, if they can also read the document." : rules.length ? "Everyone who can read the document, except:" : copy.help;

  return (
    <div className={`rounded-2xl border bg-white p-5 ${chunk.sensitivity === "restricted" ? "border-red-200" : "border-gray-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[14px] font-semibold text-gray-900">{chunk.heading ?? `Section ${chunk.ordinal + 1}`}</p>
        {canManage ? (
          <div className="w-[140px]">
            <DenSelect aria-label={`Label for ${chunk.heading ?? `section ${chunk.ordinal + 1}`}`} value={chunk.sensitivity} disabled={busy === "label"} onChange={(event) => {
              const next = sensitivities.find((value) => value === event.target.value);
              if (next && next !== chunk.sensitivity) void run("label", async () => { await labelKnowledgeChunk(chunk.id, next); await invalidate(); });
            }}>
              {sensitivities.map((value) => <option key={value} value={value}>{sensitivityCopy[value].label}</option>)}
            </DenSelect>
          </div>
        ) : <DenChip tone={copy.tone} size="sm">{copy.label}</DenChip>}
      </div>
      <p className={`mt-2 whitespace-pre-wrap text-[13px] leading-6 text-gray-700 ${expanded ? "" : "line-clamp-3"}`}>{chunk.text}</p>
      <button type="button" className="mt-1 text-[12px] font-medium text-gray-500 hover:text-gray-800" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show all"}</button>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className={`text-[12px] ${chunk.sensitivity === "restricted" && !limited ? "text-amber-700" : "text-gray-500"}`}>{readers}</p>
        {rules.length ? <div className="mt-1.5"><RuleList rules={rules} canManage={canManage} onRemoved={invalidate} /></div> : null}
        {canManage ? (
          editing
            ? <AddReader resourceKind="knowledge_chunk" resourceId={chunk.id} onAdded={async () => { await invalidate(); setEditing(false); }} />
            : <button type="button" className="mt-1.5 text-[12px] font-medium text-gray-700 underline-offset-2 hover:underline" onClick={() => setEditing(true)}>Change who can read this section</button>
        ) : null}
        {error ? <DenNotice message={error} className="mt-2" /> : null}
      </div>
    </div>
  );
}
