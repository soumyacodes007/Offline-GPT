import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAirgappedEdition } from "./edition.js";
import { installOpencodeV2Binary } from "./opencode-v2-binary.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";

describe("air-gapped edition", () => {
  test("recognizes the edition switch", () => {
    expect(isAirgappedEdition({ OFFLINEGPT_EDITION: "airgapped" })).toBe(true);
    expect(isAirgappedEdition({ OFFLINEGPT_EDITION: "Air-Gapped" })).toBe(true);
    expect(isAirgappedEdition({})).toBe(false);
  });

  test("never falls back to the public model catalog", async () => {
    await expect(resolveOpencodeModelsUrl({ env: { OFFLINEGPT_EDITION: "airgapped" } })).rejects.toThrow(/OPENCODE_MODELS_URL/);
    expect(await resolveOpencodeModelsUrl({ env: { OFFLINEGPT_EDITION: "airgapped", OPENCODE_MODELS_URL: "http://inference:8791/models" } }))
      .toBe("http://inference:8791/models");
  });

  test("refuses to download the engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "airgap-engine-"));
    const previous = process.env.OFFLINEGPT_EDITION;
    process.env.OFFLINEGPT_EDITION = "airgapped";
    try {
      await expect(installOpencodeV2Binary(join(root, "cache"), "2.3.2")).rejects.toThrow(/forbids downloading/);
    } finally {
      if (previous === undefined) delete process.env.OFFLINEGPT_EDITION;
      else process.env.OFFLINEGPT_EDITION = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
