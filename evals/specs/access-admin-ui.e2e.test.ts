import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { denFetch, evalIn, fill, waitFor, type DenSession } from "@offlinegpt/behaviors";
import { browserScript, navigate } from "@offlinegpt/cdp";
import { chrome } from "@offlinegpt/hosts";
import { screenshot } from "@offlinegpt/test-evidence";
import { mcpMock, needs, server, test } from "@offlinegpt/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

test("a member asks for access in Den Web and an owner approves it from the Access page", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OFFLINEGPT_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    web: true,
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
    mocks: { archive: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: { name: "Access UI PSU", members: { asha: { name: "Asha Rao" } } },
  });
  const owner = den.admin;
  const asha = den.members.asha;
  const archive = den.mocks.archive;
  if (!asha || !archive) throw new Error("Missing fixtures");
  const api = (session: DenSession, route: string, method = "GET", body?: unknown) =>
    denFetch(session, route, { method, headers: { authorization: `Bearer ${session.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const created = await api(owner, "/v1/mcp-connections", "POST", { name: "Payroll archive", url: archive.mcpUrl, authType: "none", access: { orgWide: false, memberIds: [], teamIds: [] } });
  expect(created.response.status, created.text).toBeLessThan(300);
  const connectionId = text(record(created.body).id);
  const usable = async () => {
    const listed = record((await api(asha, "/v1/mcp-connections")).body).connections;
    return (Array.isArray(listed) ? listed : []).map((connection) => record(connection).id);
  };
  expect(await usable()).not.toContain(connectionId);

  await using browser = await chrome({ name: "access-admin-ui", host: place.host(), startUrl: den.ref.webUrl, headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const shotsDir = path.join(process.cwd(), "tmp", "access-admin-ui");
  mkdirSync(shotsDir, { recursive: true });
  const shoot = async (name: string) => {
    const shot = await screenshot(browser);
    writeFileSync(path.join(shotsDir, `${name}.png`), shot.png);
  };
  const clickButton = (label: string) => evalIn(browser, browserScript((label) => {
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim().startsWith(label) && !entry.disabled);
    if (!button) throw new Error(`Missing enabled button ${label}`);
    button.click();
  }, [label]));
  const bodyHas = (needle: string, label: string, timeoutMs = 30_000) =>
    waitFor(browser, browserScript((needle) => document.body.innerText.includes(needle), [needle]), { timeoutMs, label });
  const signIn = async (session: DenSession) => {
    await navigate(browser.client, den.ref.webUrl);
    await waitFor(browser, browserScript((url) => location.href.startsWith(url) && document.readyState === "complete", [den.ref.webUrl]), { timeoutMs: 60_000, label: "Den Web loaded" });
    await evalIn(browser, async () => {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      localStorage.removeItem("offlinegpt:web:auth-token");
    }, { awaitPromise: true, timeoutMs: 30_000 });
    await navigate(browser.client, den.ref.webUrl);
    await waitFor(browser, () => Boolean(document.querySelector('input[type="email"]')), { timeoutMs: 30_000, label: "email step" });
    await fill(browser, 'input[type="email"]', session.email);
    await clickButton("Next");
    await waitFor(browser, () => Boolean(document.querySelector('input[type="password"]')), { timeoutMs: 30_000, label: "password step" });
    await fill(browser, 'input[type="password"]', session.password);
    await clickButton("Sign in");
    await waitFor(browser, () => location.pathname.startsWith("/dashboard"), { timeoutMs: 30_000, label: "signed in" });
  };

  // The member finds "Knowledge & access" in the sidebar and asks for the connection with a reason.
  await signIn(asha);
  await waitFor(browser, () => Boolean(document.querySelector('a[href="/dashboard/my-access"]')), { timeoutMs: 30_000, label: "Knowledge & access in the sidebar" });
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/my-access?kind=mcp_connection&id=${encodeURIComponent(connectionId)}&label=${encodeURIComponent("Payroll archive")}`);
  await bodyHas("Request access", "request form");
  // Wait for the page to settle (its request list has loaded) so a late re-render cannot clear the typed reason.
  await bodyHas("No requests yet", "request list loaded");
  const sendEnabled = () => evalIn(browser, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Send request" && !button.disabled));
  for (let attempt = 0; attempt < 5 && !(await sendEnabled()); attempt += 1) {
    await fill(browser, 'textarea[aria-label="Why do you need it?"]', "Monthly payroll reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await shoot("0-before-send");
  expect(await sendEnabled(), "Send request enabled after typing a reason").toBe(true);
  await clickButton("Send request");
  await bodyHas("Waiting for an admin", "request listed as waiting");
  await shoot("1-member-requested");
  evidence.recordAssertionEvidence("A member asks for access from Den Web", "Asha opened Knowledge & access from the sidebar, the form was prefilled from the link (MCP connection, Payroll archive), and after Send request her list showed it as Waiting for an admin.", true);

  // The owner sees it in the Access inbox with the reason and approves it.
  await signIn(owner);
  await waitFor(browser, () => Boolean(document.querySelector('a[href="/dashboard/access"]')), { timeoutMs: 30_000, label: "Access in the sidebar" });
  await evalIn(browser, () => document.querySelector<HTMLAnchorElement>('a[href="/dashboard/access"]')?.click());
  await bodyHas("Asha Rao wants to use Payroll archive", "request in the inbox");
  await bodyHas("Monthly payroll reconciliation", "reason shown to the approver");
  await shoot("2-owner-inbox");
  await clickButton("Approve for 7 days");
  await bodyHas("Nothing waiting", "inbox emptied after approval");
  expect(await usable()).toContain(connectionId);
  await clickButton("Rules");
  await bodyHas("Asha Rao can use Payroll archive", "approved rule listed in plain language");
  await bodyHas("Approved request: \"Monthly payroll reconciliation\"", "rule reason quotes the request");
  await shoot("3-owner-rules");
  evidence.recordAssertionEvidence("The owner approves from the Access page and the rule appears", "The Access inbox showed \"Asha Rao wants to use Payroll archive\" with her reason; Approve for 7 days emptied the inbox, Asha could use the connection on her next API call, and the Rules tab listed \"Asha Rao can use Payroll archive\" with her quoted reason.", true);

  // Knowledge: the owner adds a document; sections appear with their labels.
  await clickButton("Knowledge");
  await bodyHas("No documents yet", "empty knowledge base");
  await clickButton("Add document");
  await fill(browser, 'input[aria-label="Title"]', "Plant safety manual");
  await fill(browser, 'textarea[aria-label="Content"]', "# Fire drills\n\nDrills run every quarter.\n\n# Chemical storage\n\nStore acids below eye level.");
  await evalIn(browser, () => {
    const buttons = [...document.querySelectorAll("button")].filter((entry) => entry.textContent?.trim() === "Add document");
    buttons[buttons.length - 1]?.click();
  });
  await bodyHas("Plant safety manual", "document listed");
  await bodyHas("2 sections", "document split into sections");
  await clickButton("Plant safety manual");
  await bodyHas("Chemical storage", "section visible in the document view");
  await bodyHas("Who can read this document", "audience panel");
  await shoot("4-owner-knowledge-document");
  for (const width of [1280, 390]) {
    await browser.client.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await waitFor(browser, browserScript((width) => window.innerWidth === width, [width]), { timeoutMs: 10_000, label: `viewport ${width}` });
    expect(await evalIn(browser, () => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at ${width}px`).toBe(true);
  }
  await shoot("5-owner-knowledge-mobile");
  evidence.recordAssertionEvidence("Knowledge is managed from the same page", "The owner added \"Plant safety manual\" from the Knowledge tab; it was listed with 2 sections, and the document view showed each section with the readers panel. The page had no horizontal scroll at 1280 px and 390 px.", true);
});
