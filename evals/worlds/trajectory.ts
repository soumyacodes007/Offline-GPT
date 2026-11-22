import type { Seed } from "@offlinegpt/env";
import { configureProvider } from "./chat.ts";

export const trajectoryMarker = "TRAJECTORY_TOOL_ROUND";
export const trajectoryCommand = "printf '%s\\n' 'trajectory-tool-output'";
export const trajectoryReply = "Trajectory round finished cleanly.";

/** One real mocked-provider turn: a bash tool call, then a final reply. */
export async function trajectoryToolRound(seed: Seed) {
  const providerId = "trajectory-mock";
  const modelId = "trajectory-model";
  const mock = seed.mock({
    agentWorkloads: [{
      promptMarker: trajectoryMarker,
      latestUserTurn: true,
      finalReply: trajectoryReply,
      steps: [{ tool: "bash", arguments: { command: trajectoryCommand, description: "Print the trajectory marker", timeout: 30_000 } }],
    }],
  });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ name: "trajectory-tool-round", den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("trajectory-tool-round"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow" },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Trajectory mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-trajectory-mock" },
        models: { [modelId]: { name: "Trajectory model" } },
      },
    },
  });
  const [session] = await seed.sessions(app, ["Trajectory proof"]);
  return { app, den, workspace, session, mock: den.mocks.agent };
}
