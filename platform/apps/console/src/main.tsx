import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, empty, meSchema, type Me } from "./api";
import { Access } from "./pages/Access";
import { Audit, Knowledge, People, Usage } from "./pages/Admin";
import { Home } from "./pages/Home";
import { SignIn } from "./pages/SignIn";
import "./styles.css";

const PAGES = [
  { id: "home", label: "Home", admin: false },
  { id: "access", label: "Access", admin: true },
  { id: "people", label: "People", admin: true },
  { id: "knowledge", label: "Knowledge", admin: true },
  { id: "usage", label: "Usage", admin: true },
  { id: "audit", label: "Audit log", admin: true },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function readPage(): PageId {
  const hash = window.location.hash.slice(1);
  return PAGES.find((page) => page.id === hash)?.id ?? "home";
}

function Shell({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<PageId>(readPage);
  const isAdmin = me.role !== "member";
  const signOut = useMutation({ mutationFn: () => api(empty, "/auth/logout", { method: "POST" }), onSettled: () => queryClient.invalidateQueries({ queryKey: ["me"] }) });
  const go = (id: PageId) => {
    window.location.hash = id;
    setPage(id);
  };
  const current = isAdmin ? page : "home";
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-4 font-semibold">OfflineGPT Workspace</span>
            {PAGES.filter((item) => isAdmin || !item.admin).map((item) => (
              <button key={item.id} onClick={() => go(item.id)} className={`rounded-lg px-3 py-1.5 text-sm ${current === item.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{item.label}</button>
            ))}
          </div>
          <button onClick={() => signOut.mutate()} className="text-sm text-slate-600 hover:underline">Sign out</button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {current === "home" ? <Home me={me} /> : null}
        {current === "access" ? <Access /> : null}
        {current === "people" ? <People me={me} /> : null}
        {current === "knowledge" ? <Knowledge /> : null}
        {current === "usage" ? <Usage /> : null}
        {current === "audit" ? <Audit /> : null}
      </main>
    </div>
  );
}

function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api(meSchema, "/v1/me"), retry: false });
  if (me.isPending) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn />;
  if (me.isError) return <p className="p-8 text-sm text-red-700">Couldn't reach the workspace service. Try again shortly.</p>;
  return <Shell me={me.data} />;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } });
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
