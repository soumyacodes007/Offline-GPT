import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { evalIn, fill, waitFor } from "@offlinegpt/behaviors";
import { browserScript, navigate } from "@offlinegpt/cdp";
import { chrome } from "@offlinegpt/hosts";
import { screenshot } from "@offlinegpt/test-evidence";
import { needs, test } from "@offlinegpt/testkit";

// Runs against the Workspace edition started from packaging/platform/docker-compose.yml
// (see platform/README.md), after first-time setup created the owner.
const consoleUrl = process.env.OFFLINEGPT_EVAL_PLATFORM_URL ?? "";
const email = process.env.OFFLINEGPT_EVAL_PLATFORM_OWNER_EMAIL ?? "";
const password = process.env.OFFLINEGPT_EVAL_PLATFORM_OWNER_PASSWORD ?? "";

test("an employee signs in, opens their own workspace and the self-hosted model answers", { timeout: 900_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OFFLINEGPT_EVAL_E2E_TESTS"], env: ["OFFLINEGPT_EVAL_PLATFORM_URL", "OFFLINEGPT_EVAL_PLATFORM_OWNER_EMAIL", "OFFLINEGPT_EVAL_PLATFORM_OWNER_PASSWORD"] });
  await using browser = await chrome({ name: "platform-stack", host: place.host(), startUrl: consoleUrl, headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const shotsDir = path.join(process.cwd(), "tmp", "platform-stack");
  mkdirSync(shotsDir, { recursive: true });
  const shoot = async (name: string) => writeFileSync(path.join(shotsDir, `${name}.png`), (await screenshot(browser)).png);
  const bodyHas = (needle: string, label: string, timeoutMs = 60_000) =>
    waitFor(browser, browserScript((needle) => document.body.innerText.includes(needle), [needle]), { timeoutMs, label });
  const click = (label: string) => evalIn(browser, browserScript((label) => {
    const target = [...document.querySelectorAll("a,button")].find((element) => element.textContent?.trim().startsWith(label) && !(element instanceof HTMLButtonElement && element.disabled));
    if (!(target instanceof HTMLElement)) throw new Error(`Missing ${label}`);
    target.click();
  }, [label]));

  // 1. Sign in on the console.
  await navigate(browser.client, consoleUrl);
  await bodyHas("Sign in with single sign-on", "console sign-in");
  await click("Administrator password sign-in");
  await fill(browser, 'input[type="email"]', email);
  await fill(browser, 'input[type="password"]', password);
  await click("Sign in");
  await bodyHas("Your workspace", "console home");
  await shoot("1-console");

  // 2. Start the workspace; the API says where it lives.
  const workspaceUrl = await evalIn(browser, async () => {
    const response = await fetch("/v1/me/workspace", { method: "POST", credentials: "same-origin" });
    const body: unknown = await response.json();
    const url = typeof body === "object" && body !== null && "workspace" in body && typeof body.workspace === "object" && body.workspace !== null && "url" in body.workspace ? body.workspace.url : "";
    return typeof url === "string" ? url : "";
  });
  expect(workspaceUrl).not.toBe("");
  expect(new URL(workspaceUrl).port).not.toBe(new URL(consoleUrl).port);

  // 3. The workspace app opens with the same sign-in.
  await navigate(browser.client, workspaceUrl);
  await bodyHas("What do you need done?", "workspace app", 240_000);
  await shoot("2-workspace");
  evidence.recordAssertionEvidence("The employee's own workspace opens on its own origin", "After console sign-in, the workspace origin served the member's container and the app reached its task screen without another sign-in.", true);

  // 4. A task goes to the self-hosted model through the model gateway.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const composer = await evalIn(browser, () => {
    const element = document.querySelector('textarea, [contenteditable="true"]');
    if (!(element instanceof HTMLElement)) return "";
    element.focus();
    return element.tagName;
  });
  expect(composer).not.toBe("");
  await browser.client.send("Input.insertText", { text: "Reply with exactly one word: OFFLINE" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await browser.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await browser.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(browser, () => {
    const text = document.body.innerText;
    const prompt = text.indexOf("Reply with exactly one word: OFFLINE");
    // Case-sensitive on purpose: the app's own "OfflineGPT" label must not count.
    return prompt >= 0 && text.slice(prompt + 36).includes("OFFLINE");
  }, { timeoutMs: 300_000, label: "reply from the self-hosted model" });
  await shoot("3-reply");
  evidence.recordAssertionEvidence("The self-hosted model answers in the employee's workspace", "The task \"Reply with exactly one word: OFFLINE\" got a reply containing OFFLINE from vLLM via the model gateway with the member's key.", true);
});
