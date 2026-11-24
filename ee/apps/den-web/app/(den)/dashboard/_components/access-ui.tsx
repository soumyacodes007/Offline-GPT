"use client";

import { useState, type ReactNode } from "react";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Runs a mutation through the dashboard's re-auth flow and keeps its error and busy state. */
export function useActions() {
  const { runReauthableAction } = useOrgDashboard();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, action: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await runReauthableAction(label, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };
  return { error, busy, run };
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-[15px] font-semibold tracking-[-0.02em] text-gray-900">{title}</p>
      {body ? <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-gray-500">{body}</p> : null}
    </div>
  );
}

