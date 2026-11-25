"use client";

import { ArrowRight, CheckCircle2, Circle, ExternalLink, Inbox } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import {
  getAccessRoute,
  getInferenceRoute,
  getKnowledgeRoute,
  getLibraryRoute,
  getMembersRoute,
  getMyAccessRoute,
  getSsoRoute,
} from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useAccessRequests, useAccessResources, useAccessRules, useKnowledgeDocuments } from "./access-data";

function greeting(name: string | null | undefined) {
  const hour = new Date().getHours();
  return `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${name?.trim().split(/\s+/)[0] ?? "there"}`;
}

function Row({ href, title, detail, done, external }: { href: string; title: string; detail: string; done?: boolean; external?: boolean }) {
  const Status = done === undefined ? null : done ? CheckCircle2 : Circle;
  return (
    <li>
      <Link href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} className="flex items-center gap-3 px-5 py-4 hover:bg-gray-50">
        {Status ? <Status className={`h-4 w-4 shrink-0 ${done ? "text-emerald-600" : "text-gray-300"}`} aria-label={done ? "Done" : "Not done yet"} /> : null}
        <div className="min-w-0 flex-1">
          <p className={`text-[14px] font-medium ${done ? "text-gray-500" : "text-gray-900"}`}>{title}</p>
          <p className="truncate text-[12px] text-gray-500">{detail}</p>
        </div>
        {external ? <ExternalLink className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" /> : <ArrowRight className="h-4 w-4 shrink-0 text-gray-300" aria-hidden="true" />}
      </Link>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[15px] font-semibold text-gray-900">{title}</h2>
      <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">{children}</ul>
    </section>
  );
}

/**
 * The air-gapped edition's home: employees open the browser app from here and
 * see their access; admins also see what is waiting for them and what is left
 * to set up. Nothing here assumes the public internet or a desktop download.
 */
export function AirgappedHomeScreen({ isAdmin }: { isAdmin: boolean }) {
  const { user, runtimeConfig } = useDenFlow();
  const { orgId, activeOrg, orgContext } = useOrgDashboard();
  const slug = activeOrg?.slug;
  const orgName = activeOrg?.name ?? runtimeConfig.singleOrgName;
  const mine = useAccessRequests(orgId, "mine");
  const minePending = (mine.data ?? []).filter((request) => request.status === "pending").length;

  return (
    <DashboardPageTemplate
      title={greeting(user?.name)}
      description={`OfflineGPT runs entirely inside ${orgName}'s own network. Your chats, files and documents stay here.`}
      colors={["#0F172A", "#1E3A5F", "#3B6EA8", "#9CC3E6"]}
    >
      <a
        href={runtimeConfig.offlinegptWebUrl}
        className="mb-8 flex items-center justify-between gap-4 rounded-2xl bg-gray-900 px-6 py-5 text-white hover:bg-gray-800"
      >
        <div>
          <p className="text-[16px] font-semibold">Open OfflineGPT</p>
          <p className="mt-0.5 text-[13px] text-gray-300">Ask questions, work on files, and use your team's tools.</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
      </a>

      {isAdmin ? <AdminSections slug={slug} memberCount={orgContext?.members.length ?? 0} ssoConfigured={runtimeConfig.singleOrgSsoConfigured} /> : null}

      <Section title="You">
        <Row
          href={getMyAccessRoute(slug)}
          title="My access"
          detail={minePending ? `${minePending} ${minePending === 1 ? "request" : "requests"} waiting for an admin` : "Ask for a model, tool or document you can't use yet"}
        />
        <Row href={getLibraryRoute(slug)} title="My library" detail="Skills, plugins and connections shared with you" />
      </Section>
    </DashboardPageTemplate>
  );
}

function AdminSections({ slug, memberCount, ssoConfigured }: { slug: string | undefined; memberCount: number; ssoConfigured: boolean }) {
  const { orgId } = useOrgDashboard();
  const requests = useAccessRequests(orgId, "all");
  const rules = useAccessRules(orgId);
  const documents = useKnowledgeDocuments(orgId);
  const resources = useAccessResources(orgId);
  const waiting = (requests.data ?? []).filter((request) => request.status === "pending").length;
  const models = (resources.data ?? []).filter((resource) => resource.kind === "model").length;
  const ruleCount = (rules.data ?? []).filter((rule) => !rule.expired && !rule.resourceKind.startsWith("knowledge_")).length;

  return (
    <>
      {waiting > 0 ? (
        <Link href={getAccessRoute(slug)} className="mb-8 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 hover:bg-amber-100/60">
          <Inbox className="h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
          <p className="flex-1 text-[14px] font-medium text-amber-900">{waiting} {waiting === 1 ? "person is" : "people are"} waiting for access</p>
          <ArrowRight className="h-4 w-4 text-amber-700" aria-hidden="true" />
        </Link>
      ) : null}
      <Section title="Set up">
        <Row href={getSsoRoute(slug)} title="Sign in with your company directory" detail="Connect Active Directory or another SSO provider so people use their work accounts" done={ssoConfigured} />
        <Row href={getMembersRoute(slug)} title="Add people" detail={memberCount > 1 ? `${memberCount} people in the workspace` : "Invite people, or let them arrive from your directory"} done={memberCount > 1} />
        <Row href={getInferenceRoute(slug)} title="Check your models" detail={models ? `${models} ${models === 1 ? "model" : "models"} served on your own hardware` : "No model is answering yet. Check that the model server is running"} done={models > 0} />
        <Row href={getKnowledgeRoute(slug)} title="Add knowledge" detail={(documents.data ?? []).length ? `${(documents.data ?? []).length} documents` : "Upload policies and manuals OfflineGPT can answer from"} done={(documents.data ?? []).length > 0} />
        <Row href={getAccessRoute(slug)} title="Decide who can use what" detail={ruleCount ? `${ruleCount} access ${ruleCount === 1 ? "rule" : "rules"}` : "Optional: keep a model or tool to certain teams"} done={ruleCount > 0} />
      </Section>
    </>
  );
}
