import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BLANK_SLATE_PATH_ENV_KEYS,
  prepareBlankSlateProfile,
  resolveBlankSlateLaunch,
} from "./blank-slate-profile.mjs";

test("any desktop build can launch with an isolated blank-slate profile", async () => {
  const normalEnv = {
    HOME: "/Users/installed",
    OFFLINEGPT_DESKTOP_BOOTSTRAP_PATH: "/Users/installed/.config/offlinegpt/desktop-bootstrap.json",
  };
  const originalNormalEnv = { ...normalEnv };
  const normalProfile = prepareBlankSlateProfile({ argv: [], env: normalEnv });
  const normal = resolveBlankSlateLaunch({ appName: "OfflineGPT Enterprise", profile: normalProfile });
  assert.deepEqual(normal, { enabled: false, appName: "OfflineGPT Enterprise", userDataPath: null });
  assert.deepEqual(normalEnv, originalNormalEnv);

  const firstEnv = { OFFLINEGPT_DESKTOP_DISTRIBUTION: "enterprise" };
  /** @type {NodeJS.ProcessEnv} */
  const secondEnv = {};
  const firstProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: firstEnv });
  const secondProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: secondEnv });
  const first = resolveBlankSlateLaunch({ appName: "OfflineGPT Enterprise", profile: firstProfile });
  const second = resolveBlankSlateLaunch({ appName: "OfflineGPT Enterprise", profile: secondProfile });

  try {
    assert.equal(first.enabled, true);
    assert.equal(first.appName, "OfflineGPT Enterprise - Test profile");
    assert.notEqual(first.rootPath, second.rootPath);
    assert.ok(!first.userDataPath.includes("com.offlinegptlabs.offlinegpt"));

    for (const key of BLANK_SLATE_PATH_ENV_KEYS) {
      const value = firstEnv[key];
      assert.ok(value, `${key} was not overridden`);
      const relative = path.relative(first.rootPath, value);
      assert.ok(
        relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${key} escaped the blank-slate root`,
      );
    }
    assert.equal(
      firstEnv.OFFLINEGPT_DESKTOP_BOOTSTRAP_PATH,
      first.environment.OFFLINEGPT_DESKTOP_BOOTSTRAP_PATH,
    );
    assert.equal(firstEnv.OFFLINEGPT_DESKTOP_DISTRIBUTION, "enterprise");
    assert.equal("OFFLINEGPT_DEV_MODE" in firstEnv, false);
    assert.ok(first.appName.startsWith("OfflineGPT Enterprise"));
    assert.equal(normal.userDataPath, null);
    assert.equal(normal.appName, "OfflineGPT Enterprise");
    assert.equal(
      normalEnv.OFFLINEGPT_DESKTOP_BOOTSTRAP_PATH,
      originalNormalEnv.OFFLINEGPT_DESKTOP_BOOTSTRAP_PATH,
    );
  } finally {
    await Promise.all([
      rm(first.rootPath, { recursive: true, force: true }),
      rm(second.rootPath, { recursive: true, force: true }),
    ]);
  }
});
