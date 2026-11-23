import { describe, expect, test } from "bun:test";
import { createSessionSpawner, runWorkflow, type SpawnAgent, type WorkflowSessionApi } from "./workflow-engine.js";

const meta = { name: "test-workflow", description: "Exercises the engine." };

const echo: SpawnAgent = async ({ prompt }) => `done: ${prompt}`;

describe("runWorkflow", () => {
  test("fans out with Promise.all and returns the combined value", async () => {
    const result = await runWorkflow({
      meta,
      args: { files: ["a.ts", "b.ts", "c.ts"] },
      spawnAgent: echo,
      script: `
        phase("Review");
        console.log("reviewing", args.files.length);
        const replies = await Promise.all(args.files.map((file) => agent({ prompt: file, title: file })));
        return { replies, count: replies.length };
      `,
    });
    expect(result).toEqual({
      value: { replies: ["done: a.ts", "done: b.ts", "done: c.ts"], count: 3 },
      stopReason: "completed",
      agentsStarted: 3,
      logs: ["[phase] Review", "reviewing 3"],
    });
  });

  test("a failed subagent resolves null without failing the run", async () => {
    const result = await runWorkflow({
      meta,
      spawnAgent: async () => {
        throw new Error("model unavailable");
      },
      script: `return await agent({ prompt: "x", title: "one" });`,
    });
    expect(result.stopReason).toBe("completed");
    expect(result.value).toBeNull();
    expect(result.logs).toEqual(["[agent one] failed: model unavailable"]);
  });

  test("exceeding maxTotalAgents stops the run even if the script catches it", async () => {
    const result = await runWorkflow({
      meta,
      maxTotalAgents: 2,
      spawnAgent: echo,
      script: `
        try { await Promise.all([agent("a"), agent("b"), agent("c")]); } catch {}
        return "should not complete";
      `,
    });
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("maxTotalAgents (2)");
    expect(result.value).toBeNull();
  });

  test("respects the concurrency limit and queues the rest", async () => {
    let running = 0;
    let peak = 0;
    const result = await runWorkflow({
      meta,
      maxConcurrency: 2,
      spawnAgent: async ({ prompt }) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return prompt;
      },
      script: `return await Promise.all(["1", "2", "3", "4", "5"].map((p) => agent({ prompt: p })));`,
    });
    expect(result.value).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.agentsStarted).toBe(5);
    expect(peak).toBe(2);
  });

  test("a throwing script ends with an error", async () => {
    const result = await runWorkflow({ meta, spawnAgent: echo, script: `throw new Error("boom");` });
    expect(result).toMatchObject({ stopReason: "error", error: "boom", value: null });
  });

  test("a script that does not parse fails before any agent starts", async () => {
    let spawned = 0;
    const result = await runWorkflow({
      meta,
      spawnAgent: async () => String((spawned += 1)),
      script: `agent("x"); return {`,
    });
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("does not parse");
    expect(spawned).toBe(0);
  });

  test("abort cancels the run and interrupts running children", async () => {
    const controller = new AbortController();
    let interrupted = 0;
    const spawnAgent: SpawnAgent = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          interrupted += 1;
          reject(new Error("interrupted"));
        });
      });
    setTimeout(() => controller.abort(), 30);
    const result = await runWorkflow({
      meta,
      signal: controller.signal,
      spawnAgent,
      script: `return await Promise.all([agent("a"), agent("b")]);`,
    });
    expect(result.stopReason).toBe("cancelled");
    expect(result.agentsStarted).toBe(2);
    expect(interrupted).toBe(2);
  });

  test("the overall timeout ends the run with an error", async () => {
    const result = await runWorkflow({
      meta,
      timeoutMs: 30,
      spawnAgent: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stop")))),
      script: `return await agent("slow");`,
    });
    expect(result).toMatchObject({ stopReason: "error", error: "workflow timed out after 30 ms" });
  });

  test("the script cannot reach host globals", async () => {
    const result = await runWorkflow({
      meta,
      spawnAgent: echo,
      script: `
        let escaped = "blocked";
        try { escaped = agent.constructor("return typeof process")(); } catch {}
        return {
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
          setTimeout: typeof setTimeout,
          bridge: typeof bridge,
          escaped,
        };
      `,
    });
    expect(result.value).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      setTimeout: "undefined",
      bridge: "undefined",
      escaped: "blocked",
    });
  });

  test("invalid meta fails before the script runs", async () => {
    let spawned = 0;
    const result = await runWorkflow({
      meta: { name: "", description: 3 },
      spawnAgent: async () => String((spawned += 1)),
      script: `await agent("x"); return 1;`,
    });
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("invalid workflow meta");
    expect(spawned).toBe(0);
  });

  test("non-JSON return values are rejected; undefined becomes null", async () => {
    const fn = await runWorkflow({ meta, spawnAgent: echo, script: `return () => 1;` });
    expect(fn).toMatchObject({ stopReason: "error", error: "workflow return value is not JSON-serializable" });
    const big = await runWorkflow({ meta, spawnAgent: echo, script: `return 10n;` });
    expect(big.stopReason).toBe("error");
    const nothing = await runWorkflow({ meta, spawnAgent: echo, script: `await agent("x");` });
    expect(nothing).toMatchObject({ stopReason: "completed", value: null });
  });

  test("bad agent() arguments stop the run", async () => {
    const result = await runWorkflow({ meta, spawnAgent: echo, script: `return await agent({ text: "x" });` });
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("agent() expects");
  });
});

describe("createSessionSpawner", () => {
  test("creates a child with the parent's model and returns its final text", async () => {
    const calls: string[] = [];
    let waits = 0;
    const session: WorkflowSessionApi = {
      get: async () => ({ model: { id: "m1", providerID: "p1" } }),
      create: async (input) => {
        calls.push(`create ${JSON.stringify(input)}`);
        return { id: "ses_child" };
      },
      prompt: async ({ sessionID }) => {
        calls.push(`prompt ${sessionID}`);
        return { time: { created: 100 } };
      },
      wait: async () => {
        waits += 1;
      },
      // The first read happens before the turn was scheduled; the second sees it finish.
      context: async () =>
        waits === 1
          ? [{ type: "user", time: { created: 100 } }]
          : [
              { type: "idle", time: { created: 50 }, outcome: "succeeded" },
              { type: "user", time: { created: 100 } },
              { type: "assistant", time: { created: 101 }, content: [{ type: "text", text: "first" }] },
              { type: "assistant", time: { created: 102 }, content: [{ type: "reasoning" }, { type: "text", text: "final" }] },
              { type: "idle", time: { created: 103 }, outcome: "succeeded" },
            ],
      interrupt: async () => ({ interrupted: true }),
    };
    const spawn = createSessionSpawner(session, "ses_parent");
    const text = await spawn({ prompt: "do it", title: "Task", signal: new AbortController().signal });
    expect(text).toBe("final");
    expect(calls).toEqual([
      `create ${JSON.stringify({ parentID: "ses_parent", title: "Task", model: { id: "m1", providerID: "p1" } })}`,
      "prompt ses_child",
    ]);
  });
});
