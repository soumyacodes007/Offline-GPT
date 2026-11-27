import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ tone = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "secondary" | "danger" }) {
  const tones = {
    primary: "bg-slate-900 text-white hover:bg-slate-700",
    secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-100",
    danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
  };
  return <button {...props} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${tones[tone]} ${className}`} />;
}

export function Card({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-500";

export function Badge({ tone, children }: { tone: "green" | "red" | "amber" | "slate"; children: ReactNode }) {
  const tones = { green: "bg-emerald-50 text-emerald-700", red: "bg-red-50 text-red-700", amber: "bg-amber-50 text-amber-800", slate: "bg-slate-100 text-slate-700" };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-red-700">{error instanceof Error ? error.message : "Something went wrong."}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</p>;
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}
