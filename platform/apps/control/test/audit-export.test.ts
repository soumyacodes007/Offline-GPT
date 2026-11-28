import { afterEach, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { createSyslogSender, formatSyslog, parseSyslogTarget, type AuditLine } from "../src/syslog";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

test("admins export the audit log as JSON Lines, oldest first, optionally by time window", async () => {
  const forwarded: AuditLine[] = [];
  h = await createHarness({ auditSink: (event) => forwarded.push(event) });
  const owner = await h.setupOwner();
  await h.call("POST", "/v1/settings/scim-token", { token: owner });
  await h.call("POST", "/v1/library/skills", { token: owner, body: { slug: "a", title: "A", description: "a", instructions: "a" } });

  const exported = await h.call("GET", "/v1/audit/export", { token: owner });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toBe("application/x-ndjson");
  expect(exported.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.jsonl"$/);
  const lines = (await exported.text()).trim().split("\n").map((line) => JSON.parse(line));
  const ids = lines.map((line) => line.id);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(lines.map((line) => line.action)).toEqual(expect.arrayContaining(["library.skill.published", "audit.exported"]));

  const future = await h.call("GET", `/v1/audit/export?from=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`, { token: owner });
  expect((await future.text()).trim()).toBe("");
  expect((await h.call("GET", "/v1/audit/export?from=yesterday", { token: owner })).status).toBe(400);

  // Every stored event also reaches the sink (syslog in production).
  expect(forwarded.map((event) => event.action)).toEqual(expect.arrayContaining(["library.skill.published", "audit.exported"]));
});

test("members can't export the audit log", async () => {
  h = await createHarness();
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } });
  const ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  expect((await h.call("GET", "/v1/audit/export", { token: ada })).status).toBe(403);
});

const sample: AuditLine = { id: 7, at: new Date("2026-11-28T10:00:00.000Z"), actor: "mem_1", action: "rule.created", details: { kind: "skill" } };

test("syslog lines follow RFC 5424 with the event as JSON", () => {
  const line = formatSyslog(sample);
  expect(line).toMatch(/^<37>1 2026-11-28T10:00:00\.000Z \S+ offlinegpt-control - rule\.created - /);
  expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({ id: 7, actor: "mem_1", action: "rule.created", details: { kind: "skill" } });
  expect(parseSyslogTarget("tcp://siem.internal:6514")).toEqual({ protocol: "tcp", host: "siem.internal", port: 6514 });
  expect(() => parseSyslogTarget("http://siem.internal")).toThrow();
});

test("events reach a UDP and a TCP syslog collector", async () => {
  const udp = createSocket("udp4");
  const udpLine = new Promise<string>((resolve) => udp.on("message", (message) => resolve(message.toString())));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpSender = createSyslogSender({ protocol: "udp", host: "127.0.0.1", port: udp.address().port }, () => {});
  udpSender.send(sample);
  expect(await udpLine).toContain("rule.created");
  udpSender.close();
  udp.close();

  let received = "";
  const tcpLine = new Promise<string>((resolve) => {
    const server = createServer((socket) => socket.on("data", (data) => {
      received += data.toString();
      if (received.endsWith("\n")) {
        resolve(received);
        socket.destroy();
        server.close();
      }
    }));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const tcpSender = createSyslogSender({ protocol: "tcp", host: "127.0.0.1", port }, () => {});
      tcpSender.send(sample);
    });
  });
  expect(await tcpLine).toMatch(/rule\.created.*\n$/);
});
