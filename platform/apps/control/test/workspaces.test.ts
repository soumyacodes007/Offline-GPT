import { afterEach, beforeEach, expect, test } from "bun:test";
import { inferenceKeys, workspaces as workspaceRows } from "@offlinegpt-platform/db";
import { createDocker, type DockerTransport } from "../src/workspaces/docker";
import { createWorkspaceService } from "../src/workspaces/service";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

type FakeContainer = { running: boolean; body: Record<string, unknown> };
let containers: Map<string, FakeContainer>;
let dockerCalls: string[];
let containerRequests: Array<{ url: string; authorization: string | null; cookie: string | null }>;

const fakeDocker: DockerTransport = async (method, path, body) => {
  dockerCalls.push(`${method} ${path.split("?")[0]}`);
  const name = decodeURIComponent(/\/containers\/([^/?]+)/.exec(path)?.[1] ?? "");
  if (path === "/volumes/create") return { status: 201, body: {} };
  if (path.startsWith("/containers/create")) {
    const created = decodeURIComponent(/name=([^&]+)/.exec(path)?.[1] ?? "");
    containers.set(created, { running: false, body: typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {} });
    return { status: 201, body: { Id: created } };
  }
  const container = containers.get(name);
  if (!container) return { status: 404, body: { message: "No such container" } };
  if (path.endsWith("/json")) return { status: 200, body: { State: { Running: container.running } } };
  if (path.includes("/start")) { const was = container.running; container.running = true; return { status: was ? 304 : 204, body: null }; }
  if (path.includes("/stop")) { container.running = false; return { status: 204, body: null }; }
  return { status: 500, body: { message: `unexpected ${method} ${path}` } };
};

const settings = { image: "offlinegpt-workspace:test", network: "ogp-internal", modelGatewayUrl: "http://model-gateway:8791/v1", models: [{ alias: "main", displayName: "Qwen 7B", contextLength: 16384 }], memoryMb: 4096, cpus: 2, idleMs: 60 * 60 * 1000 };

let h: Harness;
let owner: string;
let scim: string;

beforeEach(async () => {
  containers = new Map();
  dockerCalls = [];
  containerRequests = [];
  h = await createHarness({
    workspaces: (db, now) => createWorkspaceService(db, createDocker(fakeDocker), settings, now),
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

  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(dockerCalls.filter((call) => call.startsWith("POST /containers/create"))).toHaveLength(1);
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
  const service = createWorkspaceService(h.db, createDocker(fakeDocker), settings, () => new Date(Date.now() + 2 * 60 * 60 * 1000));
  expect(await service.stopIdle()).toBe(1);
  expect([...containers.values()][0]?.running).toBe(false);
  containers.clear();
  await h.call("POST", "/v1/me/workspace", { token: owner });
  expect(containers.size).toBe(1);
  expect([...containers.values()][0]?.running).toBe(true);
});
