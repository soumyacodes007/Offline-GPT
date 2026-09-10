import { describe, expect, test } from "bun:test";

import type { ProviderListItem } from "../src/app/types";
import {
  getModelBehaviorOptions,
  nextModelBehaviorValue,
  previousModelBehaviorValue,
} from "../src/app/lib/model-behavior";
import {
  dedupeGlmModelOptions,
  resolveModelDisplayName,
  resolveModelProviderDisplayName,
  resolveModelProviderIconId,
  resolveSupportedGlmBackendModel,
} from "../src/app/utils";

type ProviderModel = ProviderListItem["models"][string];

const model: ProviderModel = {
  id: "gpt-5.3-codex",
  providerID: "openai",
  api: {
    id: "gpt-5.3-codex",
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "GPT-5.3 Codex",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 1,
    output: 1,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {
    none: {},
    low: {},
    medium: {},
    high: {},
    xhigh: {},
    max: {},
  },
};

describe("model behavior options", () => {
  test("uses only the raw effort values reported by the model", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Xhigh" },
    ]);
  });

  test("aliases GPT model names without changing their IDs", () => {
    expect(resolveModelDisplayName("gpt-5.6-terra", "GPT-5.6 Terra")).toBe("GLM-5.1");
    expect(resolveModelDisplayName("gpt-5.6-luna", "GPT-5.6 Luna")).toBe("GLM-4.7");
    expect(resolveModelDisplayName("claude-sonnet-4", "Claude Sonnet 4")).toBe("Claude Sonnet 4");
  });

  test("presents GPT-backed providers as Z.ai and keeps only Luna and Terra backends", () => {
    expect(resolveModelProviderDisplayName("openai", "gpt-5.6-terra", "OpenAI", "GPT-5.6 Terra")).toBe("Z.ai");
    expect(resolveModelProviderIconId("openai", "gpt-5.6-terra", "GPT-5.6 Terra")).toBe("z-ai");
    expect(dedupeGlmModelOptions([
      { providerID: "openai", modelID: "gpt-5.6-terra", title: "GLM-5.1" },
      { providerID: "openai", modelID: "gpt-5.6-luna", title: "GLM-4.7" },
      { providerID: "openai", modelID: "gpt-5.4-mini", title: "GLM-5.1" },
    ])).toHaveLength(2);
    expect(resolveSupportedGlmBackendModel(
      { providerID: "openai", modelID: "gpt-5.4-mini" },
      [],
      [],
    )).toEqual({ providerID: "openai", modelID: "gpt-5.6-terra" });
    expect(resolveSupportedGlmBackendModel(
      { providerID: "openai", modelID: "gpt-5.6-luna" },
      [],
      [],
    )).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" });
  });

  test("cycles explicit effort values and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(nextModelBehaviorValue(options, "low")).toBe("high");
    expect(nextModelBehaviorValue(options, "xhigh")).toBe("low");
    expect(nextModelBehaviorValue(options, null)).toBe("low");
  });

  test("does not cycle models with fewer than two effort values", () => {
    expect(nextModelBehaviorValue([], null)).toBeNull();
    expect(nextModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });

  test("cycles explicit effort values backward and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(previousModelBehaviorValue(options, "high")).toBe("low");
    expect(previousModelBehaviorValue(options, "low")).toBe("xhigh");
    expect(previousModelBehaviorValue(options, null)).toBe("xhigh");
  });

  test("does not cycle backward with fewer than two effort values", () => {
    expect(previousModelBehaviorValue([], null)).toBeNull();
    expect(previousModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });
});
