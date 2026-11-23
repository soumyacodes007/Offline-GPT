// OpenCode v2 plugin: the agent's scheduled-task tools, modeled on DeepSeek
// Harness's schedule_create/list/view/edit. The OfflineGPT server owns the
// tasks and their timer; these tools only call its narrow plugin route.
import { z } from "zod";
import { scheduleTargetSchema, scheduleTimingSchema } from "@offlinegpt/types/schedule";

type ToolContext = { sessionID: string; signal: AbortSignal };
type V2Tool = {
  name: string;
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: ToolContext): Promise<{ content: string }>;
};
type SetupContext = {
  tool: { transform(callback: (editor: { add(tool: V2Tool): void }) => void): unknown };
};

const TIMING_HELP = [
  "One of:",
  '{ "kind": "after", "after_seconds": 600 } — once, that many seconds from now;',
  '{ "kind": "at", "at": "2026-12-24T09:00:00+05:30" } or { "kind": "at", "at": { "date": "2026-12-24", "time": "09:00", "time_zone": "Asia/Kolkata" } } — once;',
  '{ "kind": "every", "every_seconds": 3600 } — fixed interval, at least 60;',
  '{ "kind": "daily", "daily": { "time": "09:00", "time_zone": "Europe/Berlin" } };',
  '{ "kind": "weekly", "weekly": { "time": "09:00", "time_zone": "Europe/Berlin", "weekdays": [1, 3, 5] } } — ISO weekdays, Monday 1 … Sunday 7;',
  '{ "kind": "cron", "cron": { "expression": "0 9 * * 1-5", "time_zone": "UTC" } } — five numeric fields;',
  '{ "kind": "rrule", "rrule": "DTSTART;TZID=Asia/Kolkata:20261201T090000\\nRRULE:FREQ=WEEKLY;BYDAY=MO" }.',
  "Always give an IANA time zone; when the user names none, use their time zone from this prompt.",
].join(" ");

const TARGET_HELP = 'Where each delivery lands. Omit to deliver into this chat. { "kind": "new_once" } creates one new chat on first delivery and reuses it; { "kind": "new" } creates a fresh chat every time; { "kind": "session", "session_id": "ses_..." } targets another chat.';

async function callServer(context: ToolContext, body: Record<string, unknown>): Promise<string> {
  const url = process.env.OFFLINEGPT_SERVER_URL?.replace(/\/+$/, "");
  const token = process.env.OFFLINEGPT_V2_PLUGIN_TOKEN;
  if (!url || !token) return "Scheduled tasks are only available when OpenCode is launched by OfflineGPT.";
  const response = await fetch(`${url}/internal/v2-plugin/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-offlinegpt-plugin-token": token },
    body: JSON.stringify({ ...body, sessionID: context.sessionID }),
    signal: context.signal,
  });
  const text = await response.text();
  // Errors are returned as text so the model can correct its input.
  return response.ok ? text : `Error ${response.status}: ${text}`;
}

const tools: V2Tool[] = [
  {
    name: "schedule_create",
    description: "Create a scheduled task. At each occurrence, prompt is delivered to the target chat as an ordinary message, and the agent there handles it. Tasks run only while OfflineGPT is running; after downtime only the latest missed occurrence is delivered. The result includes the task id and nextRunAt (UTC).",
    input: z.object({
      title: z.string().min(1).max(120).describe("Short task name in the user's language: action plus object. Omit timing and ids."),
      prompt: z.string().min(1).max(16000).describe("Self-contained instruction delivered at each occurrence."),
      timing: scheduleTimingSchema.describe(TIMING_HELP),
      target: scheduleTargetSchema.optional().describe(TARGET_HELP),
    }),
    async execute(input, context) {
      return { content: await callServer(context, { action: "create", request: input }) };
    },
  },
  {
    name: "schedule_list",
    description: "List this workspace's scheduled tasks, including ones created from other chats. Active tasks come first.",
    input: z.object({ active: z.boolean().optional().describe("true for active tasks only, false for paused and ended ones, omit for all.") }),
    async execute(input, context) {
      const { active } = z.object({ active: z.boolean().optional() }).parse(input);
      return { content: await callServer(context, { action: "list", ...(active === undefined ? {} : { active }) }) };
    },
  },
  {
    name: "schedule_view",
    description: "View one scheduled task by id, including its next run and recent delivery history.",
    input: z.object({ id: z.string().min(1).describe("Task id.") }),
    async execute(input, context) {
      const { id } = z.object({ id: z.string() }).parse(input);
      return { content: await callServer(context, { action: "view", id }) };
    },
  },
  {
    name: "schedule_edit",
    description: "Change, pause, resume, run now, or delete one scheduled task by id. Only do this when the user asks. Deleting does not retract messages already delivered.",
    input: z.object({
      id: z.string().min(1).describe("Task id."),
      action: z.enum(["update", "pause", "resume", "run_now", "delete"]),
      title: z.string().min(1).max(120).optional(),
      prompt: z.string().min(1).max(16000).optional(),
      timing: scheduleTimingSchema.optional().describe(TIMING_HELP),
      target: scheduleTargetSchema.optional().describe(TARGET_HELP),
    }),
    async execute(input, context) {
      const request = z.object({
        id: z.string(),
        action: z.enum(["update", "pause", "resume", "run_now", "delete"]),
        title: z.string().optional(),
        prompt: z.string().optional(),
        timing: scheduleTimingSchema.optional(),
        target: scheduleTargetSchema.optional(),
      }).parse(input);
      const { id, action, ...fields } = request;
      if (action === "delete") return { content: await callServer(context, { action: "delete", id }) };
      if (action === "run_now") return { content: await callServer(context, { action: "run", id }) };
      const update = action === "pause" ? { active: false } : action === "resume" ? { ...fields, active: true } : fields;
      return { content: await callServer(context, { action: "update", id, request: update }) };
    },
  },
];

export default {
  id: "offlinegpt.schedule",
  async setup(context: SetupContext) {
    return context.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
  },
};
