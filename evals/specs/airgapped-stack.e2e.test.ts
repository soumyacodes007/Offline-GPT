import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { evalIn, fill, waitFor } from "@offlinegpt/behaviors";
import { browserScript, navigate } from "@offlinegpt/cdp";
import { chrome } from "@offlinegpt/hosts";
import { screenshot } from "@offlinegpt/test-evidence";
import { needs, test } from "@offlinegpt/testkit";

// Runs against a live air-gapped stack started from
// packaging/docker/docker-compose.airgapped.yml (see docs/airgapped-edition).
const stackUrl = process.env.OFFLINEGPT_EVAL_AIRGAP_STACK_URL ?? "";
const email = process.env.OFFLINEGPT_EVAL_AIRGAP_EMAIL ?? "";
const password = process.env.OFFLINEGPT_EVAL_AIRGAP_PASSWORD ?? "";

test("an employee signs in on the air-gapped gateway and chats with the self-hosted model", { timeout: 900_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OFFLINEGPT_EVAL_E2E_TESTS"], env: ["OFFLINEGPT_EVAL_AIRGAP_STACK_URL", "OFFLINEGPT_EVAL_AIRGAP_EMAIL", "OFFLINEGPT_EVAL_AIRGAP_PASSWORD"] });
  await using browser = await chrome({ name: "airgapped-stack", host: place.host(), startUrl: stackUrl, headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const shotsDir = path.join(process.cwd(), "tmp", "airgapped-stack");
  mkdirSync(shotsDir, { recursive: true });
  const shoot = async (name: string) => writeFileSync(path.join(shotsDir, `${name}.png`), (await screenshot(browser)).png);
  const pageText = () => evalIn(browser, () => document.body.innerText);
  const clickText = (label: string) => evalIn(browser, browserScript((label) => {
    const target = [...document.querySelectorAll("a,button")].find((el) => el.textContent?.trim().startsWith(label) && !(el instanceof HTMLButtonElement && el.disabled));
    if (!(target instanceof HTMLElement)) throw new Error(`Missing ${label}`);
    target.click();
  }, [label]));
  const bodyHas = (needle: string, label: string, timeoutMs = 60_000) =>
    waitFor(browser, browserScript((needle) => document.body.innerText.includes(needle), [needle]), { timeoutMs, label });

  // 1. The app on the gateway asks the employee to sign in on this deployment's Den, never the hosted one.
  await navigate(browser.client, stackUrl);
  await bodyHas("Sign in to OfflineGPT", "gateway sign-in screen");
  await clickText("Sign in to OfflineGPT");
  await bodyHas("Copy sign-in link", "sign-in link shown");
  const signInLink = await evalIn(browser, () => document.body.innerText.split("\n").find((line) => /^https?:\/\//.test(line.trim()))?.trim() ?? "");
  await shoot("1-gateway-signin");
  console.log("SIGNIN_LINK", signInLink);
  expect(signInLink.startsWith("http://localhost:3005")).toBe(true);
  expect(signInLink).not.toContain("offlinegptlabs.com");

  // 2. Sign in on Den web and get the one-time code.
  await navigate(browser.client, signInLink);
  await waitFor(browser, () => Boolean(document.querySelector('input[type="email"]')), { timeoutMs: 60_000, label: "Den sign-in email step" });
  await fill(browser, 'input[type="email"]', email);
  await clickText("Next");
  await waitFor(browser, () => Boolean(document.querySelector('input[type="password"]')), { timeoutMs: 30_000, label: "password step" });
  await fill(browser, 'input[type="password"]', password);
  await clickText("Sign in");
  await bodyHas("Or paste this sign-in code", "Den shows the one-time sign-in code");
  const code = await evalIn(browser, () => [...document.querySelectorAll("input")].map((input) => input.value).find((value) => value.startsWith("offlinegpt://den-auth")) ?? "");
  await shoot("2-den-code");
  expect(code).toContain("grant=");

  // 3. Paste the code into the app on the gateway.
  await navigate(browser.client, stackUrl);
  await bodyHas("Paste sign-in code", "gateway sign-in screen again");
  await clickText("Paste sign-in code");
  await waitFor(browser, () => Boolean(document.querySelector("input,textarea")), { timeoutMs: 15_000, label: "code field" });
  await shoot("3-paste-open");
  console.log("PASTE_UI", JSON.stringify(await evalIn(browser, () => ({ inputs: [...document.querySelectorAll("input,textarea")].map((el) => [el.tagName, el.getAttribute("placeholder"), el.getAttribute("aria-label")]), buttons: [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()) }))));
  const field = await evalIn(browser, () => { const el = [...document.querySelectorAll("input,textarea")].find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null); if (!el) return ""; el.setAttribute("data-airgap-code", "1"); return el.tagName; });
  expect(field).not.toBe("");
  await fill(browser, '[data-airgap-code="1"]', code);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await clickText("Finish sign-in");

  // 4. Den starts (or wakes) the employee's own workspace and the app opens it.
  await bodyHas("What do you need done?", "workspace session view", 240_000);
  await shoot("4-workspace");
  evidence.recordAssertionEvidence("The employee reaches their own workspace through the gateway", "After pasting the code, the gateway resolved the member's Docker workspace and the app opened a session in it.", true);

  // 5. Pick the self-hosted model if the app asks, then send a task.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if ((await pageText()).includes("Search providers and models")) {
    await shoot("5-model-picker");
    await evalIn(browser, () => {
      const option = [...document.querySelectorAll("button,[role=option],li")].find((el) => /Self-hosted model|main/.test(el.textContent ?? ""));
      if (!(option instanceof HTMLElement)) throw new Error("self-hosted model not offered: " + document.body.innerText.slice(0, 400));
      option.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if ((await pageText()).includes("Search providers and models")) await clickText("Done");
  }
  const composer = await evalIn(browser, () => {
    const el = document.querySelector('textarea, [contenteditable="true"]');
    if (!(el instanceof HTMLElement)) return "";
    el.focus();
    return el.tagName;
  });
  expect(composer).not.toBe("");
  await browser.client.send("Input.insertText", { text: "Reply with exactly one word: OFFLINE" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await shoot("6-typed");
  await browser.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await browser.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

  // 6. The self-hosted model answers.
  await waitFor(browser, () => {
    const text = document.body.innerText;
    const prompt = text.indexOf("Reply with exactly one word: OFFLINE");
    // Case-sensitive on purpose: the app's own "OfflineGPT" label must not count.
    return prompt >= 0 && text.slice(prompt + 36).includes("OFFLINE");
  }, { timeoutMs: 240_000, label: "assistant reply from the self-hosted model" });
  await shoot("7-reply");
  const transcript = await pageText();
  const reply = transcript.slice(transcript.indexOf("Reply with exactly one word: OFFLINE") + 36).trim().slice(0, 200);
  console.log("REPLY", JSON.stringify(reply));
  evidence.recordAssertionEvidence("The employee chats with the self-hosted model in the browser", `In the workspace opened from the gateway, the task "Reply with exactly one word: OFFLINE" got a reply containing OFFLINE (case-sensitive, so the app's "OfflineGPT" label cannot match) from the self-hosted model (${JSON.stringify(reply.slice(0, 80))}).`, true);
});
