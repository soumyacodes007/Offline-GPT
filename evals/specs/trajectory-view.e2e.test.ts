import { expect } from "vitest";
import { spec } from "@offlinegpt/testkit";
import { trajectoryMarker, trajectoryReply, trajectoryToolRound } from "../worlds/trajectory.ts";

const test = spec.world(trajectoryToolRound, { timeout: 420_000 });
const prompt = `Run the trajectory tool round. ${trajectoryMarker}`;

test("Trajectory is a conversation view tab that inspects the turn in the main area", async ({ user, probe, step, evidence }) => {
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: trajectoryReply }, { timeoutMs: 120_000 });

  await step("the sidebar no longer carries an audit trail", async () => {
    await user.notSee({ testId: "audit-trail-toggle" });
    await user.notSee({ text: "Audit trail" });
  });

  const routeBefore = await probe.hash();
  await step("the Trajectory tab replaces the transcript with the ledger", async () => {
    await user.see({ role: "tab", label: "Chat" });
    await user.click({ role: "tab", label: "Trajectory" });
    await user.see({ label: "Trajectory toolbar" });
    await user.see({ label: "Trajectory timeline" });
    await user.see({ testId: "trajectory-row-user" });
    await user.see({ testId: "trajectory-row-message" });
    await user.see({ testId: "trajectory-row-tool" });
    await user.see({ role: "button", label: "Request #1" });
    expect(await probe.hash()).toBe(routeBefore);
    evidence.recordAssertionEvidence(
      "Trajectory renders as a main-area view tab",
      "After a real mocked-provider bash round, the Trajectory tab shows the toolbar, timeline, and USER / ASSISTANT / TOOL ledger rows with a Request #1 marker, without changing the session route.",
      true,
    );
  });

  await step("selecting the tool record opens the inspector with its payload and result", async () => {
    await user.click({ testId: "trajectory-row-tool" });
    await user.see({ label: "Event details" });
    await user.click({ role: "tab", label: "Payload" });
    await user.see({ text: /trajectory-tool-output/ });
    await user.click({ role: "tab", label: "Result" });
    await user.see({ text: /trajectory-tool-output/ });
    await user.click({ role: "button", label: "Close details" });
    await user.notSee({ label: "Event details" });
  });

  await step("the request marker opens request usage", async () => {
    await user.click({ role: "button", label: "Request #1" });
    await user.click({ role: "tab", label: "Usage" });
    await user.see({ text: "This request" });
    await user.see({ text: "Session cumulative" });
    await user.click({ role: "button", label: "Close details" });
  });

  await step("search filters the ledger and Calls folds tool rows", async () => {
    await user.type({ label: "Search trajectory" }, "printf");
    await user.see({ testId: "trajectory-row-tool" });
    await user.notSee({ testId: "trajectory-row-user" });
    // A blank query (the view trims it) restores the unfiltered ledger.
    await user.type({ label: "Search trajectory" }, " ", { replace: true });
    await user.see({ testId: "trajectory-row-user" });
    await user.click({ role: "button", label: "Collapse calls" });
    await user.see({ testId: "trajectory-summary-assistant" });
    await user.notSee({ testId: "trajectory-row-tool" });
    await user.click({ role: "button", label: "Expand calls" });
    await user.see({ testId: "trajectory-row-tool" });
  });

  await step("Chat returns to the transcript with the composer still in place", async () => {
    await user.click({ role: "tab", label: "Chat" });
    await user.notSee({ label: "Trajectory toolbar" });
    await user.see({ text: trajectoryReply });
    await user.see("composer");
  });
});
