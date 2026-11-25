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

/** A two-page PDF with real text, so the upload goes through PDFium like a customer's file. */
function twoPagePdf(pages: [string, string]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    ...pages.flatMap((line, index) => {
      const stream = `BT /F1 14 Tf 72 720 Td (${line}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("in the air-gapped portal a blocked member asks by name, an owner approves, and knowledge is uploaded as a PDF", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OFFLINEGPT_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    web: true,
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
    // The harness seeds a multi-org den-api, which the air-gapped edition refuses;
    // the portal itself renders the air-gapped edition.
    webEnv: { OFFLINEGPT_EDITION: "airgapped", DEN_WEB_OFFLINEGPT_WEB_URL: "http://offlinegpt.psu.test" },
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
  const clickLink = (href: string) => evalIn(browser, browserScript((href) => {
    const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
    if (!link) throw new Error(`Missing link ${href}`);
    link.click();
  }, [href]));
  const bodyHas = (needle: string, label: string, timeoutMs = 30_000) =>
    waitFor(browser, browserScript((needle) => document.body.innerText.includes(needle), [needle]), { timeoutMs, label });
  const bodyText = () => evalIn(browser, () => document.body.innerText);
  const choose = async (ariaLabel: string, search: string, option: string) => {
    const selector = `input[role="combobox"][aria-label="${ariaLabel}"]`;
    // Focus first, as a person clicking into the field would, then type.
    await evalIn(browser, browserScript((selector) => document.querySelector<HTMLInputElement>(selector)?.focus(), [selector]));
    await fill(browser, selector, search);
    await waitFor(browser, browserScript((option) => [...document.querySelectorAll('[role="option"]')].some((entry) => entry.textContent?.includes(option)), [option]), { timeoutMs: 15_000, label: `option ${option}` });
    await evalIn(browser, browserScript((option) => {
      const entry = [...document.querySelectorAll('[role="option"]')].find((candidate) => candidate.textContent?.includes(option));
      entry?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }, [option]));
  };
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

  // Sign-in speaks to a private deployment: no cloud wording, no Google or GitHub.
  await navigate(browser.client, den.ref.webUrl);
  await bodyHas("Everything runs inside your organization's own network.", "air-gapped sign-in copy", 60_000);
  const signInText = await bodyText();
  for (const hosted of ["Continue with Google", "Continue with GitHub", "OpenAI", "Your desktop"]) expect(signInText, `sign-in page shows "${hosted}"`).not.toContain(hosted);
  await shoot("0-sign-in");

  // The member's home opens the browser app; nothing asks them to download a desktop app.
  await signIn(asha);
  await bodyHas("Open OfflineGPT", "member home");
  await waitFor(browser, () => Boolean(document.querySelector('a[href="/dashboard/my-access"]')), { timeoutMs: 30_000, label: "My access in the sidebar" });
  const memberHome = await bodyText();
  expect(memberHome).not.toContain("Get OfflineGPT");
  expect(memberHome).not.toContain("Billing");
  expect(await evalIn(browser, () => document.querySelector<HTMLAnchorElement>('a[href="http://offlinegpt.psu.test"]') !== null), "home links to the employee app").toBe(true);
  await shoot("1-member-home");
  evidence.recordAssertionEvidence("The air-gapped portal speaks to a private deployment", "The sign-in page said \"Everything runs inside your organization's own network\" with no Google/GitHub buttons, no OpenAI vendor list and no desktop wording. Asha's home linked to the employee app (Open OfflineGPT), with My access in the sidebar and no download prompt or Billing.", true);

  // A refusal links here with only the kind and id; the page names the connection itself.
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/my-access?kind=mcp_connection&id=${encodeURIComponent(connectionId)}`);
  await bodyHas("You don't have access to Payroll archive yet", "request opened by name from a denial link");
  await bodyHas("You haven't asked for anything yet", "request list loaded");
  const sendEnabled = () => evalIn(browser, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Send request" && !button.disabled));
  for (let attempt = 0; attempt < 5 && !(await sendEnabled()); attempt += 1) {
    await fill(browser, 'textarea[aria-label="Why do you need it?"]', "Monthly payroll reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await shoot("2-member-denial-link");
  expect(await sendEnabled(), "Send request enabled after typing a reason").toBe(true);
  expect(await evalIn(browser, () => document.querySelector('input[aria-label="ID"]') === null), "no id field shown").toBe(true);
  await clickButton("Send request");
  await bodyHas("Waiting for an admin", "request listed as waiting");
  await shoot("3-member-requested");
  evidence.recordAssertionEvidence("A blocked member asks by name", "Opening the denial link (kind and id only) titled the form \"You don't have access to Payroll archive yet\" with no id field; after a reason and Send request, her list showed Payroll archive as Waiting for an admin.", true);

  // The owner's home says someone is waiting; Approve grants it; the rule reads as a sentence.
  await signIn(owner);
  await bodyHas("1 person is waiting for access", "owner home flags the request");
  await bodyHas("Set up", "owner setup checklist");
  await shoot("4-owner-home");
  await clickLink("/dashboard/access");
  await bodyHas("Asha Rao wants to use Payroll archive", "request in the inbox");
  await bodyHas("Monthly payroll reconciliation", "reason shown to the approver");
  await shoot("5-owner-inbox");
  await clickButton("Approve");
  await bodyHas("You're all caught up", "inbox emptied after approval");
  expect(await usable()).toContain(connectionId);
  await clickButton("Rules");
  await bodyHas("Asha Rao can use Payroll archive", "approved rule listed in plain language");
  await bodyHas('Approved request: "Monthly payroll reconciliation"', "rule reason quotes the request");
  expect(await bodyText(), "no raw request id in the rule reason").not.toMatch(/\(arq_/);
  expect(await evalIn(browser, () => document.querySelector("header.h-14")?.textContent?.trim().startsWith("Access") ?? false), "top bar names the page").toBe(true);
  expect(await evalIn(browser, () => document.title)).toBe("OfflineGPT");

  // A new rule is built from names: who, can't, what.
  await clickButton("Add rule");
  await choose("Who", "Asha", "Asha Rao");
  await clickButton("Can't use");
  await choose("What", "Payroll", "Payroll archive (all tools)");
  await bodyHas("Asha Rao can't use Payroll archive (all tools), even if it is shared with them.", "rule preview in plain language");
  await shoot("6-owner-rule-editor");
  await clickButton("Save rule");
  // The preview already reads like the rule, so wait for the editor to close before looking for it in the list.
  await waitFor(browser, () => !document.body.innerText.includes("New rule"), { timeoutMs: 30_000, label: "rule editor closed after save" });
  await bodyHas("Asha Rao can't use Payroll archive (all tools)", "rule saved and listed by name");
  const rules = record((await api(owner, "/v1/access-policy/rules")).body).rules;
  expect((Array.isArray(rules) ? rules : []).map((rule) => record(rule)).some((rule) => rule.resourceKind === "capability" && rule.resourceId === `mcp:${connectionId}:*` && rule.effect === "deny")).toBe(true);
  await shoot("7-owner-rules");
  evidence.recordAssertionEvidence("The owner approves and writes rules by name", `Home showed "1 person is waiting for access"; the Access inbox showed "Asha Rao wants to use Payroll archive" with her reason, and Approve emptied it and gave her the connection. A new rule chosen as Asha Rao → Can't use → "Payroll archive (all tools)" previewed and listed as a sentence and was stored as a deny on mcp:${connectionId}:*.`, true);

  // Knowledge has its own page: upload a PDF, review its text, open the document at its own URL.
  await clickLink("/dashboard/knowledge");
  await bodyHas("No documents yet", "empty knowledge base");
  await clickButton("Add your first document");
  const pdfPath = path.join(shotsDir, "Plant safety manual.pdf");
  writeFileSync(pdfPath, twoPagePdf(["Fire drills run every quarter.", "Store acids below eye level."]));
  const root = record(record(await browser.client.send("DOM.getDocument", {})).root).nodeId;
  const fileInput = record(await browser.client.send("DOM.querySelector", { nodeId: root, selector: 'input[type="file"]' })).nodeId;
  await browser.client.send("DOM.setFileInputFiles", { nodeId: fileInput, files: [pdfPath] });
  await bodyHas("Text from Plant safety manual.pdf · 2 sections", "PDF read into two sections", 60_000);
  expect(await evalIn(browser, () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value)).toBe("Plant safety manual");
  expect(await evalIn(browser, () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content"]')?.value ?? "")).toContain("Store acids below eye level.");
  await shoot("8-owner-upload-review");
  await evalIn(browser, () => {
    const buttons = [...document.querySelectorAll("button")].filter((entry) => entry.textContent?.trim() === "Add document" && !entry.disabled);
    buttons[buttons.length - 1]?.click();
  });
  // "2 sections" is also in the form's label, so wait for the document's own link in the list.
  await waitFor(browser, () => Boolean(document.querySelector('a[href^="/dashboard/knowledge/"]')), { timeoutMs: 30_000, label: "document listed" });
  await bodyHas("2 sections · added", "document listed with its sections");
  await evalIn(browser, () => document.querySelector<HTMLAnchorElement>('a[href^="/dashboard/knowledge/"]')?.click());
  await waitFor(browser, () => /^\/dashboard\/knowledge\/[^/]+$/.test(location.pathname), { timeoutMs: 30_000, label: "document has its own URL" });
  await bodyHas("Page 2", "PDF page shown as a section");
  await bodyHas("Who can read this document", "readers panel");
  await shoot("9-owner-document");
  await evalIn(browser, () => history.back());
  await waitFor(browser, () => location.pathname === "/dashboard/knowledge", { timeoutMs: 30_000, label: "back returns to the list" });
  for (const width of [1280, 390]) {
    await browser.client.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await waitFor(browser, browserScript((width) => window.innerWidth === width, [width]), { timeoutMs: 10_000, label: `viewport ${width}` });
    expect(await evalIn(browser, () => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at ${width}px`).toBe(true);
  }
  await shoot("10-owner-knowledge-mobile");
  evidence.recordAssertionEvidence("Knowledge is uploaded as a PDF and has its own pages", "From the Knowledge page the owner uploaded \"Plant safety manual.pdf\"; the form filled the title and showed its text as 2 sections for review. After adding, the document opened at /dashboard/knowledge/<id> with \"Page 2\" as a section and the readers panel, and the browser back button returned to the list. No horizontal scroll at 1280 px or 390 px.", true);
});
