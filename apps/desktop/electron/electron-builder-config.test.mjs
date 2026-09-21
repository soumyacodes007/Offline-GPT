import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function readConfig(name) {
  return YAML.parse(await readFile(path.resolve(dirname, "..", name), "utf8"));
}

describe("Electron distribution configs", () => {
  it("uses a stable Linux desktop identity and ships integration icons", async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.resolve(dirname, "..", "package.json"), "utf8"),
    );
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(packageMetadata.desktopName, "com.offlinegptlabs.offlinegpt");
    assert.equal(config.npmRebuild, false);
    assert.deepEqual(config.files.at(-1), {
      from: ".electron-runtime/node_modules",
      to: "node_modules",
    });
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.linux.icon, "resources/icons/linux");
    assert.deepEqual(config.linux.extraResources[0], {
      from: "resources/icons/linux",
      to: "icons/linux",
      filter: ["*.png"],
    });
  });

  it("keeps the public artifact and protocol unchanged", async () => {
    const config = await readConfig("electron-builder.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.offlinegptlabs.offlinegpt");
    assert.equal(config.productName, "OfflineGPT");
    assert.equal(config.protocols[0].schemes[0], "offlinegpt");
    assert.equal(config.artifactName, "offlinegpt-${os}-${arch}-${version}.${ext}");
  });

  it("defines an enterprise flavor with the standard app identity and release provider", async () => {
    const config = await readConfig("electron-builder.enterprise.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.offlinegptlabs.offlinegpt");
    assert.equal(config.productName, "OfflineGPT Enterprise");
    assert.equal(config.extraMetadata.offlinegptDistribution, "enterprise");
    assert.equal(config.protocols[0].schemes[0], "offlinegpt");
    assert.equal(config.publish[0].provider, "github");
    assert.equal(config.publish[0].owner, "soumyacodes007");
    assert.equal(config.publish[0].repo, "Offline-GPT");
    assert.equal(config.publish[0].channel, "enterprise");
    assert.equal(
      config.artifactName,
      "offlinegpt-enterprise-${os}-${arch}-${version}.${ext}",
    );
  });

  it("defines a Cloud flavor with its own artifacts and updater channel", async () => {
    const config = await readConfig("electron-builder.cloud.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.offlinegptlabs.offlinegpt");
    assert.equal(config.productName, "OfflineGPT Cloud");
    assert.equal(config.extraMetadata.offlinegptDistribution, "cloud");
    assert.equal(config.protocols[0].schemes[0], "offlinegpt");
    assert.equal(config.publish[0].channel, "cloud");
    assert.equal(
      config.artifactName,
      "offlinegpt-cloud-${os}-${arch}-${version}.${ext}",
    );
  });
});
