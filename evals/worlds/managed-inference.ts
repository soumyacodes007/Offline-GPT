import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedInference } from "@offlinegpt/env";
import type { Place } from "@offlinegpt/env";
import baselineModels from "../../ee/apps/inference/src/models/offlinegpt-models.json";
import { bootManagedOfflineGptServer } from "./offlinegpt-server-cli.ts";

export async function bootManagedInference(place: Place) {
  const service = await managedInference(place);
  const resources = new AsyncDisposableStack();
  resources.use(service);
  return {
    ...service,
    async bootEngine() {
      const scratch = await realpath(await mkdtemp(join(tmpdir(), "offlinegpt-managed-inference-")));
      resources.defer(() => rm(scratch, { recursive: true, force: true }));
      const workspace = join(scratch, "workspace");
      await mkdir(workspace);
      const file = join(workspace, "inference-fixture.txt");
      await writeFile(file, "Managed inference tool result\n");
      service.witness.readToolFile(file);
      // Seed one checked-in baseline model, not a new catalog or variant map.
      // This proves the server/engine transport, not cloud delivery or the picker.
      const model = baselineModels["z-ai/glm-5.2"];
      await writeFile(join(workspace, "opencode.json"), JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: ["offlinegpt"],
        model: "offlinegpt/z-ai/glm-5.2", small_model: "offlinegpt/z-ai/glm-5.2",
        provider: { offlinegpt: {
          npm: "@openrouter/ai-sdk-provider", name: "OfflineGPT Models",
          options: { baseURL: `${service.url}/api/v1`, apiKey: service.identity.key },
          models: { [model.id]: { name: model.name, limit: model.limit, modalities: model.modalities, tool_call: model.tool_call } },
          whitelist: [model.id],
        } },
      }));
      let output = "";
      const engine = await bootManagedOfflineGptServer({ scratch, workspace, token: "managed-inference-fixture-client", sink: (chunk) => { output += chunk; } });
      resources.defer(() => engine.stop());
      return { ...engine, output: () => output };
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
