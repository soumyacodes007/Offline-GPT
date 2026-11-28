import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api } from "../api";
import { Button, ErrorText, Field, inputClass } from "../ui";

const tokenSchema = z.object({ token: z.string() });

export function SignIn() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"sso" | "password" | "setup">("sso");
  const [form, setForm] = useState({ email: "", password: "", name: "", code: "" });
  const submit = useMutation({
    mutationFn: () =>
      mode === "setup"
        ? api(tokenSchema, "/setup", { method: "POST", body: { email: form.email, password: form.password, name: form.name, code: form.code } })
        : api(tokenSchema, "/auth/local", { method: "POST", body: { email: form.email, password: form.password } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate();
  };
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">OfflineGPT Workspace</h1>
      <p className="mt-1 text-sm text-slate-500">Sign in with your organization account.</p>
      {mode === "sso" ? (
        <div className="mt-6 grid gap-3">
          <a href="/auth/sso/start" className="rounded-lg bg-slate-900 px-3 py-2 text-center text-sm font-medium text-white hover:bg-slate-700">Sign in with single sign-on</a>
          <button type="button" onClick={() => setMode("password")} className="text-xs text-slate-500 underline">Administrator password sign-in</button>
          <button type="button" onClick={() => setMode("setup")} className="text-xs text-slate-500 underline">First-time setup</button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3">
          {mode === "setup" ? <Field label="Your name"><input className={inputClass} value={form.name} onChange={set("name")} required /></Field> : null}
          <Field label="Email"><input className={inputClass} type="email" value={form.email} onChange={set("email")} required /></Field>
          <Field label="Password" hint={mode === "setup" ? "At least 12 characters. This is the break-glass owner account." : undefined}>
            <input className={inputClass} type="password" value={form.password} onChange={set("password")} required />
          </Field>
          {mode === "setup" ? <Field label="Setup code" hint="From the deployment's SETUP_CODE setting."><input className={inputClass} value={form.code} onChange={set("code")} required /></Field> : null}
          <ErrorText error={submit.error} />
          <Button type="submit" disabled={submit.isPending}>{mode === "setup" ? "Create owner account" : "Sign in"}</Button>
          <button type="button" onClick={() => setMode("sso")} className="text-xs text-slate-500 underline">Back to single sign-on</button>
        </form>
      )}
    </main>
  );
}
