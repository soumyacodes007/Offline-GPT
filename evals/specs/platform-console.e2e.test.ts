import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { evalIn, fill, waitFor } from "@offlinegpt/behaviors";
import { browserScript, navigate } from "@offlinegpt/cdp";
import { chrome } from "@offlinegpt/hosts";
import { screenshot } from "@offlinegpt/test-evidence";
import { needs, test } from "@offlinegpt/testkit";

// Runs against a fresh platform control service with the console built in
// (see platform/README.md). The deployment must have no members yet.
const baseUrl = process.env.OFFLINEGPT_EVAL_PLATFORM_URL ?? "";
const ownerEmail = process.env.OFFLINEGPT_EVAL_PLATFORM_OWNER_EMAIL ?? "";
const setupCode = process.env.OFFLINEGPT_EVAL_PLATFORM_SETUP_CODE ?? "";

test("an IT admin sets up the workspace, publishes a document and controls who can read it", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OFFLINEGPT_EVAL_E2E_TESTS"], env: ["OFFLINEGPT_EVAL_PLATFORM_URL", "OFFLINEGPT_EVAL_PLATFORM_OWNER_EMAIL", "OFFLINEGPT_EVAL_PLATFORM_SETUP_CODE"] });
  await using browser = await chrome({ name: "platform-console", host: place.host(), startUrl: baseUrl, headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const shotsDir = path.join(process.cwd(), "tmp", "platform-console");
  mkdirSync(shotsDir, { recursive: true });
  const shoot = async (name: string) => writeFileSync(path.join(shotsDir, `${name}.png`), (await screenshot(browser)).png);
  const bodyHas = (needle: string, label: string, timeoutMs = 30_000) =>
    waitFor(browser, browserScript((needle) => document.body.innerText.includes(needle), [needle]), { timeoutMs, label });
  const click = (label: string) => evalIn(browser, browserScript((label) => {
    const target = [...document.querySelectorAll("a,button")].find((element) => element.textContent?.trim() === label && !(element instanceof HTMLButtonElement && element.disabled));
    if (!(target instanceof HTMLElement)) throw new Error(`Missing ${label}`);
    target.click();
  }, [label]));
  /** Fill the input or textarea whose label text starts with `label`. */
  const fillLabelled = async (label: string, value: string) => {
    const id = await evalIn(browser, browserScript((label) => {
      const field = [...document.querySelectorAll("label")].find((element) => element.querySelector("span")?.textContent?.trim().startsWith(label));
      const input = field?.querySelector("input,textarea");
      if (!(input instanceof HTMLElement)) throw new Error(`Missing field ${label}`);
      const marker = `f-${Math.random().toString(36).slice(2)}`;
      input.setAttribute("data-eval", marker);
      return marker;
    }, [label]));
    await fill(browser, `[data-eval="${id}"]`, value);
  };

  // 1. First-time setup creates the owner and signs them in.
  await navigate(browser.client, baseUrl);
  await bodyHas("Sign in with single sign-on", "sign-in page");
  await shoot("1-sign-in");
  await click("First-time setup");
  await fillLabelled("Your name", "IT Admin");
  await fillLabelled("Email", ownerEmail);
  await fillLabelled("Password", "correct horse battery staple");
  await fillLabelled("Setup code", setupCode);
  await click("Create owner account");
  await bodyHas("Signed in as IT Admin", "owner home page");
  await shoot("2-home");
  evidence.recordAssertionEvidence("First-time setup signs the owner in", "Setup with the configured email and code showed the home page for the new owner.", true);

  // 2. Publish a private document; the owner cannot find it yet.
  await click("Knowledge");
  await bodyHas("Add a document", "knowledge page");
  await fillLabelled("Path", "policies/hr/leave");
  await fillLabelled("Title", "Leave policy");
  await fillLabelled("Text", "# Parental leave\nParents get 26 weeks of paid parental leave.");
  await evalIn(browser, () => {
    const box = document.querySelector('input[type="checkbox"]');
    if (box instanceof HTMLInputElement && box.checked) box.click();
  });
  await click("Add document");
  await bodyHas("policies/hr/leave · 1 sections", "document listed");
  await shoot("3-document");

  await click("Home");
  await evalIn(browser, () => {
    const input = document.querySelector('input[placeholder="e.g. parental leave"]');
    if (input instanceof HTMLInputElement) input.setAttribute("data-eval", "search");
  });
  await fill(browser, '[data-eval="search"]', "parental");
  await click("Search");
  await bodyHas("Nothing you can read matches that search.", "private document hidden");
  evidence.recordAssertionEvidence("A new document is private", "Searching for its text found nothing before any rule named the owner as a reader.", true);

  // 3. Allow the owner role to read it, then search again.
  await click("Access");
  await bodyHas("Add a rule", "access page");
  await evalIn(browser, () => {
    const selects = [...document.querySelectorAll("select")];
    const set = (select: HTMLSelectElement | undefined, value: string) => {
      if (!select) throw new Error("missing select");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const form = [...document.querySelectorAll("section")].find((section) => section.textContent?.includes("Add a rule"));
    const formSelects = form ? [...form.querySelectorAll("select")] : selects;
    set(formSelects[0], "knowledge-document");
    set(formSelects[2], "role");
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await evalIn(browser, () => {
    const form = [...document.querySelectorAll("section")].find((section) => section.textContent?.includes("Add a rule"));
    const role = form ? [...form.querySelectorAll("select")][3] : undefined;
    if (!(role instanceof HTMLSelectElement)) throw new Error("missing role select");
    role.value = "owner";
    role.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await fillLabelled("Target", "policies/hr/*");
  await fillLabelled("Reason", "HR policies for owners");
  await click("Add rule");
  await bodyHas("HR policies for owners", "rule listed");
  await shoot("4-rule");

  await click("Home");
  await evalIn(browser, () => {
    const input = document.querySelector('input[placeholder="e.g. parental leave"]');
    if (input instanceof HTMLInputElement) input.setAttribute("data-eval", "search2");
  });
  await fill(browser, '[data-eval="search2"]', "parental");
  await click("Search");
  await bodyHas("26 weeks of paid parental leave", "document found after the rule");
  await shoot("5-found");
  evidence.recordAssertionEvidence("A rule opens the document to its audience", "After an allow rule on policies/hr/* for owners, the same search returned the parental leave section.", true);

  // 4. The audit log shows what happened.
  await click("Audit log");
  await bodyHas("rule.created", "audit log lists the rule");
  const audit = await evalIn(browser, () => document.body.innerText);
  expect(audit).toContain("knowledge.document.uploaded");
  expect(audit).toContain("setup.completed");
  await shoot("6-audit");
  evidence.recordAssertionEvidence("The audit log records setup, upload and the rule", "The Audit log page listed setup.completed, knowledge.document.uploaded and rule.created.", true);
});
