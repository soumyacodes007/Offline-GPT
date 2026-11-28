import { afterEach, beforeEach, expect, test } from "bun:test";
import { inferenceKeys, workspaces as workspaceRows } from "@offlinegpt-platform/db";
import { createDocker, type DockerTransport } from "../src/workspaces/docker";
import { createWorkspaceService } from "../src/workspaces/service";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

type FakeContainer = { running: boolean; body: Record<string, unknown> };
let containers: Map<string, FakeContainer>;
let volumes: Set<string>;
/** Scripts run by one-off task containers, with their mounts. */
let tasks: Array<{ script: string; binds: string[] }>;
let dockerCalls: string[];
let containerRequests: Array<{ url: string; authorization: string | null; cookie: string | null }>;
let deliveries: Array<{ url: string; hostToken: string | null; body: unknown }>;
let warmups = 0;

/** Stands in for a workspace server accepting its provider. */
const deliverFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.endsWith("/workspaces")) return Response.json({ items: [{ id: "ws_1" }] });
  if (url.endsWith("/opencode2/api/session")) { warmups += 1; return Response.json([]); }
  deliveries.push({ url: input instanceof Request ? input.url : input.toString(), hostToken: new Headers(init?.headers).get("x-offlinegpt-host-token"), body: JSON.parse(typeof init?.body === "string" ? init.body : "null") });
  return Response.json({ ok: true });
};

const fakeDocker: DockerTransport = async (method, path, body) => {
  dockerCalls.push(`${method} ${path.split("?")[0]}`);
  const name = decodeURIComponent(/\/containers\/([^/?]+)/.exec(path)?.[1] ?? "");
  if (path === "/volumes/create") {
    const volume = typeof body === "object" && body !== null && "Name" in body && typeof body.Name === "string" ? body.Name : "";
    volumes.add(volume);
    return { status: 201, body: {} };
  }
  if (method === "DELETE" && path.startsWith("/volumes/")) return { status: volumes.delete(decodeURIComponent(path.slice("/volumes/".length))) ? 204 : 404, body: null };
  if (method === "DELETE" && path.startsWith("/containers/")) return { status: containers.delete(name) ? 204 : 404, body: null };
  if (path.startsWith("/containers/create")) {
    const created = decodeURIComponent(/name=([^&]+)/.exec(path)?.[1] ?? "");
    containers.set(created, { running: false, body: typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {} });
    return { status: 201, body: { Id: created } };
  }
  const container = containers.get(name);
  if (!container) return { status: 404, body: { message: "No such container" } };
  if (path.endsWith("/json")) return { status: 200, body: { State: { Running: container.running } } };
  if (path.endsWith("/wait")) {
    const spec = container.body;
    const script = Array.isArray(spec.Cmd) ? String(spec.Cmd[0]) : "";
    const hostConfig = typeof spec.HostConfig === "object" && spec.HostConfig !== null ? spec.HostConfig : {};
    const binds = "Binds" in hostConfig && Array.isArray(hostConfig.Binds) ? hostConfig.Binds.map(String) : [];
    tasks.push({ script, binds });
    return { status: 200, body: { StatusCode: 0 } };
  }
  if (path.includes("/start")) { const was = container.running; container.running = true; return { status: was ? 304 : 204, body: null }; }
  if (path.includes("/stop")) { container.running = false; return { status: 204, body: null }; }
  return { status: 500, body: { message: `unexpected ${method} ${path}` } };
};

const settings = { image: "offlinegpt-workspace:test", network: "ogp-internal", modelGatewayUrl: "http://model-gateway:8791/v1", controlUrl: "http://control:8790", models: [{ alias: "main", displayName: "Qwen 7B", contextLength: 16384 }], memoryMb: 4096, cpus: 2, idleMs: 60 * 60 * 1000 };

let h: Harness;
let owner: string;
let scim: string;

beforeEach(async () => {
  containers = new Map();
  volumes = new Set();
  tasks = [];
  dockerCalls = [];
  containerRequests = [];
  deliveries = [];
  warmups = 0;
  h = await createHarness({
    workspaces: (db, now) => createWorkspaceService(db, createDocker(fakeDocker), settings, now, deliverFetch, 0),
    route: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!url.hostname.startsWith("ogp-ws-")) return null;
      const headers = new Headers(init?.headers);
      containerRequests.push({ url: url.toString(), authorization: headers.get("authorization"), cookie: headers.get("cookie") });
      return Response.json({ path: url.pathname, query: url.search });
    },
  });
  owner = await h.setupOwner();
  scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
});
afterEach(async () => {
  await h.close();
});

test("the first start creates the member's container with their own model key, and later starts reuse it", async () => {
  const started = await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(await json(started)).toEqual({ workspace: { status: "running", url: "/w/" } });
  const [name] = [...containers.keys()];
  const spec = containers.get(name ?? "")?.body ?? {};
  expect(spec).toMatchObject({ Image: "offlinegpt-workspace:test", HostConfig: { NetworkMode: "ogp-internal", Memory: 4096 * 1024 * 1024 } });
  const env = (spec.Env as string[]).join("\n");
  expect(env).toContain('"baseURL":"http://model-gateway:8791/v1"');
  expect(env).toMatch(/"apiKey":"ogk_[A-Za-z0-9_-]+"/);
  expect((await h.db.select().from(inferenceKeys)).filter((key) => key.revokedAt === null)).toHaveLength(1);

  expect(deliveries.map((delivery) => delivery.url)).toEqual([`http://${name}:8787/runtime-config/providers`, `http://${name}:8787/runtime-config/mcp`, `http://${name}:8787/runtime-config/managed-policy`]);
  // Nothing is restricted until an admin sets a policy, and that clears any old one.
  expect(deliveries[2]?.body).toEqual({ policy: null });
  expect(deliveries[0]?.hostToken).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(deliveries[0]?.body)).toContain('"baseURL":"http://model-gateway:8791/v1"');
  // The engine reaches the platform's knowledge and skills tools with the member's own key.
  // The engine is warmed before the workspace is reported as running.
  expect(warmups).toBe(1);
  expect(deliveries[1]?.body).toEqual({ mcp: { offlinegpt: { type: "remote", url: "http://control:8790/mcp", headers: { Authorization: expect.stringMatching(/^Bearer ogk_/) }, enabled: true } } });

  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(dockerCalls.filter((call) => call.startsWith("POST /containers/create"))).toHaveLength(1);
  expect(deliveries).toHaveLength(3);
});

test("the router sends a member only to their own container, with the container token instead of theirs", async () => {
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } });
  const ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect((await h.call("GET", "/w/session", { token: ada })).status).toBe(409);
  await h.call("POST", "/v1/me/workspace", { token: ada });

  const ownerReply = await json(await h.call("GET", "/w/session/list?limit=5", { token: owner }));
  expect(ownerReply).toEqual({ path: "/session/list", query: "?limit=5" });
  const ownerId = String((await json(await h.call("GET", "/v1/me", { token: owner }))).id);
  const rows = await h.db.select().from(workspaceRows);
  const ownerRow = rows.find((row) => row.memberId === ownerId);
  const adaRow = rows.find((row) => row.memberId !== ownerId);
  await h.call("GET", "/w/x", { token: ada, cookie: "ogp_session=secret" });
  expect(containerRequests.map((request) => new URL(request.url).hostname)).toEqual([String(ownerRow?.containerName), String(adaRow?.containerName)]);
  expect(containerRequests[1]?.authorization).toBe(`Bearer ${adaRow?.token}`);
  expect(containerRequests[1]?.cookie).toBeNull();
  expect((await h.call("GET", "/w/x")).status).toBe(401);
});

test("SCIM deactivation stops the member's workspace", async () => {
  const id = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } }))).id);
  const bob = sessionFrom(await h.oidcSignIn({ sub: "b", email: "bob@example.test", name: "Bob" }));
  await h.call("POST", "/v1/me/workspace", { token: bob });
  expect([...containers.values()].some((container) => container.running)).toBe(true);
  await h.call("PATCH", `/scim/v2/Users/${id}`, { scim, body: { Operations: [{ op: "replace", path: "active", value: false }] } });
  expect([...containers.values()].every((container) => !container.running)).toBe(true);
});

test("idle workspaces are stopped and a vanished container is recreated on the next start", async () => {
  await h.call("POST", "/v1/me/workspace", { token: owner });
  const service = createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(Date.now() + 2 * 60 * 60 * 1000), deliverFetch, 0);
  expect(await service.stopIdle()).toBe(1);
  expect([...containers.values()][0]?.running).toBe(false);
  containers.clear();
  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(containers.size).toBe(1);
  expect([...containers.values()][0]?.running).toBe(true);
});

test("the workspace origin sends signed-in members to their own container and others to sign-in", async () => {
  const { createWorkspaceOrigin } = await import("../src/routes/workspaces");
  const service = createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(), deliverFetch, 0);
  const origin = createWorkspaceOrigin({ db: h.db, config: (await import("../src/config")).parseConfig({ DATABASE_URL: "pglite:memory", PUBLIC_URL: "http://control.example.test", OWNER_EMAIL: "owner@example.test", SETUP_CODE: "setup-code-0123456789" }), now: () => new Date(), fetch: async (input) => { containerRequests.push({ url: input instanceof Request ? input.url : input.toString(), authorization: null, cookie: null }); return Response.json({ ok: true }); }, workspaces: service }, service);
  const signedOut = await origin.request("/session");
  expect(signedOut.status).toBe(302);
  expect(signedOut.headers.get("location")).toBe("http://control.example.test/");
  const signedIn = await origin.request("/assets/app.js?v=1", { headers: { cookie: `ogp_session=${owner}` } });
  expect(signedIn.status).toBe(200);
  expect(new URL(containerRequests.at(-1)?.url ?? "").pathname).toBe("/assets/app.js");
  // The app sends its container token as Authorization; the cookie still decides who it is.
  const apiCall = await origin.request("/workspaces", { headers: { cookie: `ogp_session=${owner}`, authorization: "Bearer container-token" } });
  expect(apiCall.status).toBe(200);
  expect([...containers.values()].some((container) => container.running)).toBe(true);
});

test("a browser gets a self-refreshing page while the workspace container starts", async () => {
  const { createWorkspaceOrigin } = await import("../src/routes/workspaces");
  const service = createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(), deliverFetch, 0);
  const config = (await import("../src/config")).parseConfig({ DATABASE_URL: "pglite:memory", PUBLIC_URL: "http://control.example.test", OWNER_EMAIL: "owner@example.test", SETUP_CODE: "setup-code-0123456789" });
  const origin = createWorkspaceOrigin({ db: h.db, config, now: () => new Date(), fetch: async () => { throw new TypeError("connection refused"); }, workspaces: service }, service);
  const page = await origin.request("/", { headers: { cookie: `ogp_session=${owner}`, accept: "text/html" } });
  expect(page.status).toBe(503);
  expect(await page.text()).toContain('http-equiv="refresh"');
  const api = await origin.request("/workspaces", { headers: { cookie: `ogp_session=${owner}` } });
  expect(api.status).toBe(502);
});

test("issuing a personal key leaves the member's workspace key working", async () => {
  await h.call("POST", "/v1/me/workspace", { token: owner });
  const env = ((containers.values().next().value?.body.Env ?? []) as string[]).join("\n");
  const workspaceKey = /"apiKey":"(ogk_[A-Za-z0-9_-]+)"/.exec(env)?.[1] ?? "";
  const listTools = (key: string) => h.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect((await listTools(workspaceKey)).status).toBe(200);

  const first = String((await json(await h.call("POST", "/v1/me/inference-key", { token: owner }))).key);
  const second = String((await json(await h.call("POST", "/v1/me/inference-key", { token: owner }))).key);
  expect((await listTools(workspaceKey)).status).toBe(200);
  expect((await listTools(second)).status).toBe(200);
  // A new personal key still replaces the previous personal key.
  expect((await listTools(first)).status).toBe(401);
});

test("a leaver's workspace is deleted after the retention period, not before", async () => {
  const id = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } }))).id);
  const bob = sessionFrom(await h.oidcSignIn({ sub: "b", email: "bob@example.test", name: "Bob" }));
  await h.call("POST", "/v1/me/workspace", { token: bob });
  expect(volumes.size).toBe(1);
  await h.call("PATCH", `/scim/v2/Users/${id}`, { scim, body: { Operations: [{ op: "replace", path: "active", value: false }] } });

  const day = 24 * 60 * 60 * 1000;
  const at = (offset: number) => createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(Date.now() + offset), deliverFetch, 0);
  expect(await at(29 * day).purgeLeavers(30 * day)).toEqual([]);
  expect(volumes.size).toBe(1);

  const purged = await at(31 * day).purgeLeavers(30 * day);
  expect(purged.map((leaver) => leaver.memberId)).toEqual([id]);
  expect(containers.size).toBe(0);
  expect(volumes.size).toBe(0);
  expect(await h.db.select().from(workspaceRows)).toEqual([]);
  expect((await h.db.select().from(inferenceKeys)).filter((key) => key.memberId === id && key.purpose === "workspace" && key.revokedAt === null)).toEqual([]);
});

test("the admin's workspace policy reaches running workspaces at once and every workspace on start", async () => {
  await h.call("POST", "/v1/me/workspace", { token: owner });
  deliveries = [];
  const policy = { commands: "allow", blockedCommands: ["curl *", "scp *"], browserOrigins: ["https://intranet.example.gov/"], blockBrowserUploads: true };
  const saved = await h.call("PUT", "/v1/settings/workspace-policy", { token: owner, body: policy });
  expect(saved.status).toBe(200);
  expect((await json(saved)).missed).toBe(0);
  expect(deliveries.map((delivery) => new URL(delivery.url).pathname)).toEqual(["/runtime-config/managed-policy"]);
  expect(deliveries[0]?.body).toEqual({ policy: { execution: { commands: "allow", blockedCommands: ["curl *", "scp *"], browserOrigins: ["https://intranet.example.gov"], blockBrowserUploads: true } } });

  // A stopped workspace gets the current policy when it starts again.
  const [row] = await h.db.select().from(workspaceRows);
  for (const container of containers.values()) container.running = false;
  await h.db.update(workspaceRows).set({ status: "stopped" });
  deliveries = [];
  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(deliveries.map((delivery) => new URL(delivery.url).hostname)).toEqual([String(row?.containerName)]);
  expect(JSON.stringify(deliveries[0]?.body)).toContain("curl *");

  expect((await h.call("PUT", "/v1/settings/workspace-policy", { token: owner, body: { ...policy, browserOrigins: ["https://intranet.example.gov/path"] } })).status).toBe(400);
  expect((await json(await h.call("GET", "/v1/settings/workspace-policy", { token: owner }))).policy).toEqual({ ...policy, browserOrigins: ["https://intranet.example.gov"] });
});

test("checkpoints keep the newest few, and an admin restores the latest", async () => {
  await h.call("POST", "/v1/me/workspace", { token: owner });
  const [row] = await h.db.select().from(workspaceRows);
  const name = String(row?.containerName);
  const minute = 60 * 1000;
  for (const offset of [1, 2, 3]) {
    const service = createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(Date.now() + offset * minute), deliverFetch, 0);
    expect(await service.checkpointAll(2)).toBe(0);
  }
  const snapshots = tasks.filter((task) => task.script.startsWith("tar czf"));
  expect(snapshots).toHaveLength(3);
  // The member's files are mounted read-only for a snapshot.
  expect(snapshots[0]?.binds).toEqual([`${name}-data:/data:ro`, "offlinegpt-checkpoints:/checkpoints"]);
  // The oldest was pruned once a third existed.
  const prune = tasks.find((task) => task.script.startsWith("rm -f"));
  expect(prune?.script).toContain(snapshots[0]?.script.split(" ")[2] ?? "missing");
  const ownerId = String(row?.memberId);
  const listed = await json(await h.call("GET", `/v1/workspaces/${ownerId}/checkpoints`, { token: owner }));
  expect((listed.checkpoints as unknown[]).length).toBe(2);

  const restored = await h.call("POST", `/v1/workspaces/${ownerId}/restore`, { token: owner });
  expect(restored.status).toBe(200);
  const restore = tasks.at(-1);
  expect(restore?.script).toMatch(/^find \/data -mindepth 1 -delete && tar xzf \/checkpoints\/ogp-ws-.*\.tgz -C \/data$/);
  expect(restore?.binds[0]).toBe(`${name}-data:/data`);
  expect([...containers.values()].find((container) => !container.body.Entrypoint)?.running).toBe(false);
  expect((await h.call("POST", "/v1/workspaces/mem_nobody/restore", { token: owner })).status).toBe(404);
});
