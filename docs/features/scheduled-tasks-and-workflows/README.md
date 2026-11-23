# Scheduled tasks and the workflow tool

OfflineGPT's old Automations, Workflows, Saved Apps and Remote sessions were removed. Two features modeled on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) replace them:

- **Scheduled tasks**: a prompt that OfflineGPT sends into a chat on a schedule.
- **The `workflow` tool**: a short script the agent writes to fan work out to parallel subagents.

Both run on the local OfflineGPT server and the OpenCode v2 engine. Neither needs Den, a cloud runner, or a desktop runner.

Source designs: DeepSeek Harness `docs/subsystems/schedule.md`, `docs/subsystems/workflow.md`, and `packages/schedule` and `packages/workflow`. The design was ported, not the code: DeepSeek Harness is built on Cordis, while OfflineGPT is built on OpenCode v2 plus the OfflineGPT server.

## What you get

| Facility | How to use it |
|---|---|
| Scheduled tasks page | Sidebar → **Scheduled tasks** (`#/schedule`), or the command palette → "Scheduled tasks". Create, run now, pause/resume, delete, view delivery history, open the chat a delivery landed in. |
| Agent schedule tools | Ask in any chat: *"remind me every weekday at 9 to check email"*. The agent uses `schedule_create`, `schedule_list`, `schedule_view` and `schedule_edit`. |
| Seven timing kinds | `after` (seconds from now), `at` (one instant), `every` (≥ 60 s, anchor-aligned), `daily`, `weekly` (ISO weekdays), `cron` (5 fields), `rrule` (RFC 5545 subset). Every wall-clock kind carries an IANA time zone. |
| Three delivery targets | `new_once` (one dedicated chat, created on first delivery and then reused; the default in the UI), `new` (a fresh chat each time), `session` (an existing chat; the default when an agent creates the task from a chat). |
| Workflow tool | Ask: *"review these 5 files in parallel and merge the findings"*. The agent writes a script using `agent()`, `Promise.all`, `phase()` and `args`, and gets one JSON result back. |
| REST API | `GET/POST /workspace/:id/schedule`, `GET/PATCH/DELETE /workspace/:id/schedule/:taskId`, `POST /workspace/:id/schedule/:taskId/run`, `DELETE /workspace/:id/schedule/ended` |

## How Scheduled tasks work

```
            ┌──────────── OfflineGPT server ────────────┐
 UI page ──►│ /workspace/:id/schedule (client token)    │
            │        │                                  │
 agent tool │  ScheduleService ── schedule.json         │
 (v2 plugin)│   one FIFO · 15 s timer · history         │
   │        │        │ deliver()                        │
   └───────►│ /internal/v2-plugin/schedule              │
 plugin     │  (per-boot plugin token, workspace taken  │
 token      │   from the calling chat)                  │
            │        ▼                                  │
            │ /workspace/:id/opencode2/api/session/...  │ ← same route chats use,
            │  create chat → set model → prompt         │   so OfflineGPT instructions
            └────────────────────┬──────────────────────┘   are attached
                                 ▼
                          OpenCode v2 engine
```

- **Storage:** `schedule.json` next to the runtime database. Writes are atomic (temp file, then rename). A malformed file is refused rather than silently emptied.
- **One FIFO:** reads, edits, run-now and timer deliveries are serialized, so a delivery never races an edit.
- **Timer:** one tick every 15 s.
  - A due task is delivered once, then its next occurrence is committed.
  - After downtime, only the latest missed occurrence is delivered (latest-only catch-up); missed occurrences are not replayed.
  - One-shots end after delivering.
- **Busy chats:** if a reused chat is mid-turn, delivery waits for the next tick instead of interrupting.
- **Spacing:** at least 60 s between deliveries of one task, timed or manual.
- **Run now:** delivers immediately without moving the committed schedule.
- **Delivery:**
  - Delivery goes through the server's own `/workspace/:id/opencode2` route, so each scheduled message gets the same OfflineGPT instruction entries as a normal chat (context, capabilities, steering).
  - The model is the task's model, or else the engine's default model.
- **History:** newest first. It keeps 200 records or 30 days, whichever is fewer, and always keeps the latest record. Failures are recorded with the error text.
- **Optimistic edits:** pass `expected_updated_at`; a stale value returns `409 schedule_conflict`.

### Timing evaluator (`apps/server/src/schedule/timing.ts`)

- **Wall-clock kinds** (`daily`, `weekly`, `cron`) skip times that a DST gap removes. On an overlap they choose the earlier instant.
- **Cron:**
  - Five numeric fields; `*`, values, ranges, steps and lists.
  - Sunday is 0 or 7.
  - Vixie day matching: when both day fields are restricted, *either* day field may match.
  - Names, macros and a seconds field are rejected with a readable message.
- **RRULE:**
  - Exactly a `DTSTART` line (ending in `Z`, or with `;TZID=Zone`) and an `RRULE:` line.
  - `rrule` 2.8.1 evaluates it in UTC "floating" time, and luxon converts the result. This keeps results independent of the host machine's time zone (rrule's own TZID handling is not).
- **`every`** stays aligned to its anchor, so missed intervals coalesce instead of drifting.

### Security

- **Plugin route:**
  - The engine's plugin calls `/internal/v2-plugin/schedule` with a random per-boot token (`OFFLINEGPT_V2_PLUGIN_TOKEN`), compared in constant time.
  - The token is passed to the engine through its environment allowlist. The engine still never receives the server's client or host token.
- **Workspace scoping:**
  - The plugin route takes the workspace from the **calling chat's** directory, never from tool input, so a prompt cannot reach another workspace's tasks.
  - All REST routes are workspace-scoped and require collaborator scope for writes.

## How the workflow tool works

Files: `apps/server/src/opencode-plugins/v2/workflow-engine.ts`, registered in `offlinegpt-tools.ts`.

- **Input:**
  - `script` (a JavaScript function body; top-level `await` is allowed; it ends with `return <JSON>`).
  - `meta` (`{ name, description, whenToUse?, phases? }`), validated before anything runs.
  - Optional `args`.
- **Script API:**
  - `await agent({ prompt, title? })` starts a child chat (`parentID` = the caller, with the caller's model) and resolves with its final text, or `null` on failure.
  - `phase(title)` reports progress.
  - `console` output is captured.
- **Limits:**
  - At most 16 agents per run, and 4 running at once (the rest queue).
  - The whole run times out after 20 minutes.
  - The tool call's abort signal interrupts the running children.
- **Sandbox:**
  - A fresh `node:vm` context with string code generation disabled.
  - No `require`, `process`, `fetch` or timers.
  - Host functions never cross into the context (checked by a test).
- **Result:** `{ value, stopReason: completed | cancelled | error, error?, agentsStarted, logs }`.
- **How the engine is reached:** it uses the plugin's own `ctx.session` API (`create`, `prompt`, `wait`, `context`, `interrupt`), not HTTP.

## What was removed

| Area | Removed |
|---|---|
| Desktop app | Automations page and editor, the automation-proposal tool card, the local Workflows panel, Saved Apps (Apps page, app artifacts, the dashboard's personal apps), the `@desktop` / `@cloud` computer-task mentions |
| Server | Local workflows service and routes, Connect automation catalog, the `automation.propose` action, automation prompt guidance |
| Electron | Desktop automation runner, its IPC handler and preload bridge, wake-on-resume polling |
| Shared packages | `@offlinegpt/automations`; `@offlinegpt/types` `automations`, `workflows`, `local-workflows` |
| Den API | Automations service, scheduler loop, runner protocol, cloud agent executor, automation MCP index, remote-session commands and capabilities, Workflows/Apps/artifact-view routes and builders, workflow run history. Old workflow objects in org libraries now answer "unsupported" instead of running. |
| Den web | Automations page, Workflow detail/runs pages, workflow analytics, palette and nav entries, library workflow rows, plugin Workflows section |
| Den DB | Migration `0095_remove_automations_saved_apps_remote_sessions` drops 11 tables: `automation*` (6), `workflow_run`, `artifact_view`, `artifact_view_revision`, `dashboard_app`, `remote_session_command` |
| Evals | 9 journey specs and 3 worlds for the removed features; the remote-session world |

Kept: org-managed **Dashboards** (MCP app tiles), ad-hoc `execute_capability_script` (Code Mode), and the MCP Apps UI extension (moved to `mcp/mcp-app-capabilities.ts`, which plugin-flow and skill-created apps need).

## Verification

**Live, in the desktop app on OpenCode v2:**
- A REST-created `after 70 s` task was delivered 2 s after it was due into a new chat titled after the task. That chat had all three OfflineGPT instruction entries and the model replied `SCHEDULED OK`. The one-shot then moved to `ended`.
- In a chat, the agent created "Weekday morning check" through `schedule_create`. It stored `weekly` Mon–Fri 09:00 Asia/Kolkata with next run `2026-11-24T03:30:00Z`.
- The `workflow` tool ran two parallel subagents and returned `{ "first": "ALPHA", "second": "BETA" }`.
- The Scheduled tasks page rendered the task with timing, target, next run and actions. Opening it made no failed requests and no v1 engine calls.

**Unit tests:**
- Schedule: `bun --conditions=development test src/schedule/` passes 13/13. It covers timing for every kind, DST gaps, Vixie cron, RRULE TZID, catch-up, busy deferral, pause/resume, run-now spacing, persistence and failure history.
- Workflow engine: `src/opencode-plugins/v2/workflow-engine.test.ts` passes 13/13.

**Typecheck** has 0 errors in `apps/app`, `apps/server`, `packages/types`, `ee/apps/den-api`, `ee/apps/den-web` and `ee/packages/den-db`.

**Not run:**
- The `evals` journey specs, because the evals workspace has no `node_modules` on this machine.
- No new journey spec for Scheduled tasks or the workflow tool was added yet. AGENTS.md asks for one, so this is follow-up work.

## Known limitations and follow-ups

- **App must be running:** tasks only run while OfflineGPT (the local server) is running. There is no OS-level wake.
- **v2 only:** Scheduled tasks need OpenCode v2 chat routing; a delivery on v1 fails with a clear message.
- **Duplicate child reports:** v2 sends each finished subagent's report back to the parent chat, so after `workflow` returns the parent can also see those reports. That duplicates context. The only engine-side switch found is a reserved session-ID prefix, which was deliberately not used.
- **Hang risk:** an infinite *synchronous* loop after a script's first `await` is not covered by the 5 s vm timeout and can block the engine process. Running scripts in a worker thread would fix it.
- **Stale generated files:** `packages/docs/openapi.json` and `packages/sdk/src/gen/*` are generated from Den and still list the removed endpoints. Regenerate them from a running den-api.
- **Den deploy:** applying migration `0095` permanently drops the automation, saved-app and remote-session data. Back up first.
- **Rollback:** deleted files can be restored from git history.
