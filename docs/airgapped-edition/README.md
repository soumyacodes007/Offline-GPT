# Air-gapped edition

Status: first working version on `feat/airgapped-edition` (2026-11-24); access
page, access requests and the knowledge base added 2026-11-25. Every
claim below has a passing journey spec or a recorded live run; gaps are listed
at the end.

OfflineGPT ships as two editions from one codebase:

| | Hosted | Air-gapped |
|---|---|---|
| Who | Normal users | PSUs and other regulated orgs |
| Client | Desktop app + hosted Den | Browser, served from inside the customer network |
| Where the agent runs | The user's PC | One workspace container per employee (offlinegpt-server + OpenCode v2) |
| Models | 50+ cloud providers | The customer's own vLLM (any OpenAI-compatible server) |
| Permissions | Den grants + desktop policies | The same, plus qm-style access policy rules |
| Network | Internet | No outbound traffic |
| Switch | (default) | `OFFLINEGPT_EDITION=airgapped` |

The hosted edition behaves as before when the switch is unset.

## Architecture

```
Browser ──► den-gateway  (serves the web UI, proxies each member to their workspace)
              │
              ├──► den-api ── SSO (OIDC/SAML) + SCIM, grants, access policy, audit log
              │      │  PROVISIONER_MODE=docker: one workspace container per member
              │      ▼
              ├──► workspace  (offlinegpt-server + bundled OpenCode v2 2.3.2, files on volumes)
              │      │  OPENCODE_MODELS_URL → inference /models
              │      ▼
              └──► inference gateway  (INFERENCE_UPSTREAM_URL, model access policy)
                     ▼
                   vLLM  (weights mounted read-only, HF_HUB_OFFLINE=1)

All of it on `offlinegpt-internal`, an internal Docker network with no route out.
Only den-gateway and den-web also join `offlinegpt-edge` to publish their ports.
```

## What each piece does

### 1. The edition switch

`OFFLINEGPT_EDITION=airgapped` (helper: `ee/packages/utils/src/edition.ts`,
server: `apps/server/src/edition.ts`). Each service refuses to start when it is
configured to call a public service, so a mistake shows at boot, not as a
silent outbound call.

| Service | Refuses | Changes defaults |
|---|---|---|
| den-api | Stripe, Polar, Loops, Linear, Resend, Render, Vercel, Daytona, OpenRouter management, Google/GitHub sign-in and GitHub connector keys; `PROVISIONER_MODE=render/daytona`; `DEN_ORG_MODE=multi_org`; breached-password screening; GitHub desktop releases; hosted bot protection | Web access is included (no subscription); breach screening off; desktop releases `static` |
| inference | `OPENROUTER_UPSTREAM_URL`, OpenAI keys, `SENTRY_DSN`; starting without `INFERENCE_UPSTREAM_URL` or `INFERENCE_PROXY_BASE_URL` | — |
| offlinegpt-server (workspace) | Downloading the OpenCode v2 engine; the public model catalog | Engine env `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_FREE_MODELS=1` (and `OPENCODE_DISABLE_MODELS_FETCH=1` without a catalog URL); engine config `share: "disabled"` |

### 2. Self-hosted inference

`ee/apps/inference` forwards to any OpenAI-compatible server when
`INFERENCE_UPSTREAM_URL` is set (for example `http://vllm:8000/v1`):

- **Model catalog**: read from the upstream's `GET /models` (cached 30 s, with
  vLLM's `max_model_len`), or listed in `INFERENCE_MODELS`
  (`[{ alias, upstreamModel?, displayName?, contextLength? }]`).
- **Workspace catalog**: `GET /models/api.json` serves the OpenCode model
  catalog for the self-hosted models, so workspaces set
  `OPENCODE_MODELS_URL=http://inference:8791/models` instead of the public one.
- **No OpenRouter key per org**: OpenRouter-only body fields (`trace`,
  `session_id`) are dropped.
- **Session affinity**: `X-OfflineGpt-Session-Id` is forwarded as
  `x-session-id` for the vLLM router's `consistent_hash`.
- Inference keys, limits and the existing managed-models policy are unchanged.

### 3. Access policy (qm-style)

Table `access_policy_rule` (migration `0096`), evaluator
`ee/packages/den-db/src/access-policy.ts`, admin API
`ee/apps/den-api/src/routes/org/access-policy.ts`.

A rule gives or removes access to one resource, to every resource of a kind
(`resourceId: "*"`), or to every resource whose id starts with a prefix
(`mcp:<connectionId>:*`), for one **principal**:

| Principal | Meaning |
|---|---|
| `member` | One employee |
| `team` | A Den team, including teams synced from SCIM/AD groups (departments, plants, …) |
| `role` | Everyone with a Den role (`owner`, `admin`, `member`, or a custom role) |
| `org` | Everyone in the organization |

Decision, in order (like qm, a member's access is the union of their principals):

1. A matching **deny** blocks, even over grants.
2. A matching **allow** permits.
3. A resource that has any allow rule is **restricted** to its grantees (an
   explicit grant in the resource's own table still counts). "Only IT may use
   the coder model" is a single allow rule for the IT team.
4. Otherwise the resource's normal default applies: models are open to the
   org; plugins, skills and connections need their usual grants.

Rules can be **time-bound** (`expiresAt`) and carry a `reason`. Removed or
expired rules have no effect. Org admins can still manage every resource; use
policy limits what members can *use*.

**Enforced on**

| Kind | Where |
|---|---|
| `model` | Inference gateway: `GET /api/v1/models` lists only allowed models; chat with a denied model returns `403 model_not_allowed` |
| `plugin`, `marketplace`, `config_object` (skills, commands, agents, MCP configs) | den-api resource role checks and the MCP gateway's capability search/execute |
| `connector_instance` | den-api resource role checks |
| `mcp_connection` | Member usable and visible connection lists, including native providers |
| `llm_provider` | Every member list of usable model providers and provider connect checks |
| `capability` | MCP gateway: a denied tool action is hidden from `search_capabilities` and from code-mode scripts, and `execute_capability` refuses it with `access_policy_denied` (audited) |
| `knowledge_document`, `knowledge_chunk` | Knowledge base search, the member document view, and the agent's `search_knowledge` tool (section 4) |

Background work (scheduled tasks) runs with its owner's authority, as in qm,
and every model call, tool call and knowledge search it makes is checked live
against the rules at that moment, so a rule change or a leaver's removal
applies to their next scheduled run without a separate check.

**Admin page**: Den Web → Team → **Access** has four tabs:

- **Requests**: each request reads "Asha wants to use Payroll archive", with
  the member's reason, how long they asked for, and when it expires. The
  approver approves it for that time, or for a different one, or declines it
  with a note.
- **Rules**: rules are grouped by resource, as sentences ("Finance can't use
  coder"), with who they apply to, when they end, and the reason. New rules
  show a preview of what they will do before saving.
- **Check access**: pick a person and a resource to see the decision, the rule
  behind it, and every principal the person counts as. Use it for access
  reviews.
- **Knowledge**: documents, their readers, and each section's label and rules.

Members get **Knowledge & access** in the sidebar. It holds knowledge search,
a request form (it can be prefilled from a link,
`/dashboard/my-access?kind=model&id=coder`), and the status of their own
requests. Model refusals point people to it.

**Access requests** (as qm's keychain asks):

- A member asks with a reason and a duration: 1, 7, 30 or 90 days, or until
  removed.
- A repeat request returns the pending one, and a member can have at most 20
  waiting.
- Unanswered requests expire after 7 days.
- An owner or super-admin approves or declines. Nobody can approve their own
  request, and two approvers cannot both approve the same request.
- Approval writes a member allow rule that ends after the approved duration
  and quotes the request in its reason.
- Every step is audited: `organization.access_request.created`, `approved` and
  `declined`.

**Admin API** (owner or super-admin for writes, admin for reads):

```
GET    /v1/access-policy/rules[?resourceKind=model]
POST   /v1/access-policy/rules   { resourceKind, resourceId, principalKind, principalId, effect, expiresAt?, reason? }
DELETE /v1/access-policy/rules/:ruleId
POST   /v1/access-policy/check   { memberId, resourceKind, resourceId }  → the decision and the member's principals
POST   /v1/access-requests              (member) { resourceKind, resourceId, resourceLabel?, purpose, requestedDays }
GET    /v1/access-requests?scope=mine|all&status=…
POST   /v1/access-requests/:id/approve  { durationDays?, note? }
POST   /v1/access-requests/:id/decline  { note? }
POST   /v1/access-requests/:id/cancel   (requester)
```

**Audit**: rule creation and removal are org audit events
(`organization.access_policy.rule_created` / `rule_removed`), and a denial of
something a member was otherwise granted (or a model refusal) is recorded as
`access_policy.denied` with the rule, resource, surface and reason.

### 4. Knowledge base with permissions per section

Tables `knowledge_document` and `knowledge_chunk` (migration `0097`), logic in
`ee/packages/den-db/src/knowledge.ts`, API in
`ee/apps/den-api/src/routes/org/knowledge.ts`.

- **Documents** are plain text or Markdown. Each heading starts a section
  (chunk), and long sections are split at about 1,200 characters.
- **A document is closed by default.** Adding one writes allow rules for its
  readers (everyone by default).
- **Rules per section**: a section can be denied to someone, or limited to
  certain people. A section rule never opens a document the member cannot
  read.
- **Labels per section** (from qm's memory records): `ordinary`, `sensitive`
  or `restricted`.
  - Search results that include sensitive sections are audited as
    `knowledge.sensitive_read`.
  - A restricted section needs an allow rule on the section itself. Access to
    the document is not enough.
- **Search** uses a MySQL FULLTEXT index, so it needs no extra service and no
  GPU. It only looks at documents the member can read. Each candidate section
  is checked fresh against the rules, and decisions are never cached, so a
  removed rule applies on the next search.
- **The agent** gets the `search_knowledge` tool in Den's MCP gateway. It runs
  as the member, so the agent sees exactly what that person may read.
- **Removing a document** deletes its sections, so the text leaves search
  immediately. Creating and removing documents, and relabelling sections, are
  audited.

```
POST   /v1/knowledge/documents        (owner/super-admin) { title, text, audience?, sensitivity? }
GET    /v1/knowledge/documents        admins: all with readers and labels; members: what they can read
GET    /v1/knowledge/documents/:id    admins: every section with rules; members: readable sections + hidden count
PATCH  /v1/knowledge/chunks/:id       { sensitivity }
DELETE /v1/knowledge/documents/:id
POST   /v1/knowledge/search           { query, limit? }  as the calling member
```

### 5. Leavers lose access at once

When a member is removed by an admin or deprovisioned by SCIM:

- their inference keys stop working on the next request (`401`);
- every workspace token is revoked;
- their workspace container is stopped, with files kept for retention.

This runs on top of the existing removal steps (API keys, sessions, connected
accounts). See `ee/apps/den-api/src/workers/member-offboarding.ts`.

### 6. One workspace per employee (`PROVISIONER_MODE=docker`)

`ee/apps/den-api/src/workers/docker.ts` drives the Docker Engine API over its
socket (no new dependency). For each member it starts the workspace image on
`DOCKER_WORKER_NETWORK`:

- named volumes `<name>-workspace` and `<name>-data`;
- no-new-privileges, optional CPU and memory limits;
- the same bootstrap script the cloud runtime uses.

Re-provisioning replaces the container but keeps the volumes, and stopping
never deletes data. `WORKER_ENV_*` variables on den-api reach every workspace
with the prefix removed (for example `WORKER_ENV_OPENCODE_MODELS_URL`).

| Setting | Default |
|---|---|
| `DOCKER_WORKER_IMAGE` | required |
| `DOCKER_WORKER_NETWORK` | required |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` |
| `DOCKER_WORKER_NAME_PREFIX` | `offlinegpt-ws` |
| `DOCKER_WORKER_PORT` | `8787` |
| `DOCKER_WORKER_MEMORY_MB`, `DOCKER_WORKER_CPUS` | unlimited |
| `DOCKER_WORKER_HEALTH_TIMEOUT_MS` | `180000` |

### 7. Packaging

| File | What |
|---|---|
| `packaging/docker/Dockerfile.workspace-airgapped` | Workspace image: offlinegpt-server, the web UI, v1 and v2 plugins, and the pinned OpenCode v2 engine verified by SHA-256 at build time. It runs as a non-root user. |
| `packaging/docker/docker-compose.airgapped.yml` | The whole stack on one host: MySQL, Redis, den-api, den-web, den-gateway, inference, vLLM (GPU), on the internal network |
| `packaging/helm/offlinegpt-ee` | `config.edition`, `config.inference.upstreamUrl` / `models`, an optional in-cluster `vllm` (model from a PVC); example `examples/values.airgapped.yaml` |
| `scripts/airgap-bundle.mjs` | On a connected machine: builds and pulls every image, `docker save`s them, adds the compose file and optional model weights, writes `SHA256SUMS` and an `install.sh` that verifies and `docker load`s inside the isolated network |

## Deployment model: one Docker host, no Kubernetes

The supported air-gapped deployment is a single Docker host running
`docker-compose.airgapped.yml`. Kubernetes is not required and is not planned
until a customer needs it.

- **Capacity**: an idle workspace uses roughly 0.3–1 GB of RAM, so one 64–128 GB
  server should hold about 50–150 concurrent employees. This is an estimate and
  has not been load-tested. GPU throughput for the model is the real limit, not
  where workspaces run.
- **Operations**: one machine and one `docker compose up -d`, with no cluster
  for the customer's IT team to run.
- **When this stops being enough**: more employees than one or two servers can
  hold, failover of workspaces to another machine, or a customer that only
  accepts OpenShift/Kubernetes. The first two are cheaper to solve by letting
  the Docker provisioner place workspaces on several Docker hosts. A
  `PROVISIONER_MODE=kubernetes` provisioner is built only on a real customer
  request.

The Helm chart's `config.edition` and `vllm` values stay for customers that
already run Den on Kubernetes, but per-employee workspaces still need a Docker
host.

## Deploying (one host)

On a machine with internet access:

```
node scripts/airgap-bundle.mjs --out ./offlinegpt-airgapped --models /path/to/Qwen2.5-0.5B-Instruct
```

Move `./offlinegpt-airgapped` into the isolated network, then:

```
./install.sh
cat > .env <<'EOF'
OFFLINEGPT_PUBLIC_URL=https://offlinegpt.example.internal       # employee app (den-gateway, port 8080)
OFFLINEGPT_GATEWAY_ORIGIN=https://offlinegpt.example.internal   # same origin, https only: sign-in returns straight to the app
OFFLINEGPT_ADMIN_URL=https://admin.offlinegpt.example.internal  # Den web: sign-in and admin console (port 3005)
OFFLINEGPT_API_URL=https://api.offlinegpt.example.internal      # den-api, called by Den web (port 8788)
OFFLINEGPT_ADMIN_EMAIL=it-admin@example.internal                # the first owner; /setup accepts the code only with it
OFFLINEGPT_MYSQL_PASSWORD=...
OFFLINEGPT_AUTH_SECRET=...            # 32+ characters
OFFLINEGPT_DB_ENCRYPTION_KEY=...      # 32+ characters
OFFLINEGPT_GATEWAY_KEY=...            # 32+ characters
OFFLINEGPT_ADMIN_BOOTSTRAP_CODE=...   # one-time code for /setup
OFFLINEGPT_MODELS_DIR=/srv/offlinegpt/models
EOF
docker compose -f docker-compose.airgapped.yml up -d
```

Put your TLS reverse proxy (or load balancer) in front of the three published
ports. Then:

1. Open `$OFFLINEGPT_ADMIN_URL/setup`, enter `OFFLINEGPT_ADMIN_EMAIL` and the
   bootstrap code, and create the owner account.
2. Turn on the self-hosted models: Models → OfflineGPT Models → Enable. Every
   member gets an inference key and the "OfflineGPT Models" provider.
3. Connect SSO and SCIM (Settings → SSO / SCIM), and add access rules (Team →
   Access).
4. Employees open `$OFFLINEGPT_PUBLIC_URL`, sign in, and get their own
   workspace on first use.

Other settings worth knowing:

| Setting | Default | What |
|---|---|---|
| `OFFLINEGPT_MODEL_DIR`, `OFFLINEGPT_MODEL_ALIAS`, `OFFLINEGPT_MODEL_DISPLAY_NAME` | `Qwen2.5-0.5B-Instruct`, `main`, `Self-hosted model` | Which weights vLLM serves and how employees see them. The served models are also declared to the inference gateway (`INFERENCE_MODELS`), so workspaces see them even while vLLM is still loading. |
| `OFFLINEGPT_MAX_MODEL_LEN` | `16384` | Context length. OpenCode's agent prompt alone is about 9–10k tokens. |
| `OFFLINEGPT_GPU_MEMORY_UTILIZATION` | `0.85` | Lower it on small GPUs (0.75 on a 4 GB card). |
| `OFFLINEGPT_INTERNAL_SUBNET` | `172.30.231.0/24` | The internal network. den-api trusts the client IP its proxies forward from it, so each employee gets their own sign-in rate limit. Change it if it overlaps your network. |
| `OFFLINEGPT_WORKSPACE_MEMORY_MB`, `OFFLINEGPT_WORKSPACE_CPUS` | `4096`, `2` | Limits per employee workspace. |

**Workspace files** live in each container's working copy and are
checkpointed to the member's volume every 5 minutes (`DEN_CKPT_INTERVAL_SECONDS`,
3 kept). A replaced or recovered container restores the latest checkpoint, so
at most the last few minutes of work are lost if a container is killed.

**vLLM notes**: the image's entrypoint needs `--model=/models/<dir>` (a
positional model argument is ignored and falls back to a Hub download, which
fails offline). On small or desktop GPUs, lower `OFFLINEGPT_GPU_MEMORY_UTILIZATION`.
OpenCode's agent prompt is about 9–10k tokens, so give the model at least a
16k context.

## Proof

All run locally on 2026-11-24 with an RTX 3050 (4 GB):

- vLLM v0.11.0 served Qwen2.5-0.5B-Instruct offline (`HF_HUB_OFFLINE=1`).
- The model took 0.93 GiB; the KV cache held 133k tokens at a 32k context.

| Journey spec | Proves | Result |
|---|---|---|
| `evals/specs/airgapped-inference.test.ts` (real vLLM via `OFFLINEGPT_EVAL_VLLM_URL`, or a stand-in) | Self-hosted catalog and `/models/api.json`; a team-restricted model is hidden, refused (`403`) and audited; the permitted employee gets a vLLM answer ("Ready."); deny beats the team allow; a removed member's key fails on the next request; public upstreams refused at boot | Passed (vLLM and stand-in) |
| `evals/specs/airgapped-workspace.test.ts` (real vLLM via `OFFLINEGPT_EVAL_VLLM_CONTAINER`, or a stand-in) | den-api's Docker provisioner starts the workspace on an internal network; bundled engine 2.3.2 runs; `https://github.com` (DNS) and `1.1.1.1` (IP) unreachable while `vllm` is reachable; Den-style provider delivery returns 200; the agent replies "OFFLINE" from the local model | Passed (vLLM and stand-in) |
| `evals/specs/access-policy-admin.test.ts` | Rule writes guarded (`403` member, `400` bad principal or kind); a member deny hides an org-wide MCP connection from one member only; `/check` names the rule; removal restores access; a member requests access, the owner approves it for 1 day, and the member can use it on the next request; repeat requests, self-service approval and double approval are refused; a decline is final; a capability deny removes one connection's actions from gateway search and execute; provider rules remove and add model providers; every step audited | Passed |
| `evals/specs/knowledge-base-permissions.test.ts` | A handbook split into 3 sections; one section limited to HR and one restricted; the same search returns different sections to an HR member and a clerk, through the API and the agent's `search_knowledge` tool; a restricted section needs a named reader; removing the document's readers closes it; sensitive reads, labels and removal audited, sections deleted | Passed |
| `evals/specs/airgapped-stack.e2e.test.ts` (Chrome against the running compose stack) | The full stack from `docker-compose.airgapped.yml`: the gateway app sends the employee to this deployment's Den web to sign in (never the hosted site); Den web signs them in and gives the one-time code; pasting it in the app opens the member's own Docker workspace, which Den creates (or recovers after its container was removed); a task sent in the browser is answered by vLLM on the GPU through the inference gateway with the member's key ("OFFLINE") | Passed (real vLLM, Qwen2.5-0.5B) |
| `evals/specs/access-admin-ui.e2e.test.ts` (Den Web in Chrome) | A member asks for a connection from Knowledge & access; the owner sees the request and reason in Access → Requests and approves it; the member can use it; Rules shows "Asha Rao can use Payroll archive" with the quoted reason; the owner adds a document in Knowledge and sees its sections; no horizontal scroll at 1280 px and 390 px | Passed |

Run them with:

```
pnpm evals:pr specs/airgapped-inference.test.ts
OFFLINEGPT_EVAL_VLLM_URL=http://127.0.0.1:8000/v1 pnpm evals:pr specs/airgapped-inference.test.ts
pnpm evals:pr specs/airgapped-workspace.test.ts          # needs the workspace image
OFFLINEGPT_EVAL_DEN_RUNTIME_PREPARED=1 pnpm evals:pr specs/access-policy-admin.test.ts   # Windows: prepared runtime
pnpm evals:pr specs/knowledge-base-permissions.test.ts
# against a running stack (see "Deploying"):
OFFLINEGPT_EVAL_E2E_TESTS=1 OFFLINEGPT_EVAL_AIRGAP_STACK_URL=http://localhost:8080 \
  OFFLINEGPT_EVAL_AIRGAP_EMAIL=... OFFLINEGPT_EVAL_AIRGAP_PASSWORD=... pnpm evals:e2e airgapped-stack
OFFLINEGPT_EVAL_E2E_TESTS=1 pnpm evals:e2e access-admin-ui   # needs a den-web build in prepared mode
```

The unit and route tests next to the code also pass: edition parsing; den-api
env refusals; the policy evaluator; Docker provisioner calls; inference proxy
and catalog (80/80).

## What we took from qm, and what we left

From qm (`src/acl`, `src/credentials/keychain.ts`,
`docs/memory-records.md`, `docs/SPEC.md`):

| qm | Here | Why |
|---|---|---|
| Access is the union of a person's principals (person, channel or group, org) | member, team (SCIM groups), role, org principals | Same model; AD groups already arrive as teams |
| Breaking isolation needs an explicit, auditable grant | allow rules with reason, expiry and audit | Same principle |
| Keychain asks: purpose, "once" or "until revoked", expiry, owner approves or declines, approval creates the grant | Access requests with purpose, duration, 7-day expiry, approval writes a time-bound rule | Same flow. Durations replace "once", because one-time use has no meaning for a model or connection |
| Memory records labelled ordinary, sensitive or restricted; fail closed; nothing cached between reads | Per-section labels, fresh checks on every search, restricted needs a named reader | Same rules, applied to the knowledge base |
| Background work runs with its owner's authority | Scheduled tasks are checked live at each call | Same; no separate cron permission layer |
| Durable approvals with atomic claims (its "non-durability" lesson) | Approvals are claimed with a guarded UPDATE in a transaction | Two approvers cannot both approve |
| Batch authorization per request, no N+1 (its "performance" lesson) | Rules loaded once per request and decided in memory | Same |

Left out, on purpose:

- **Audience checks for shared rooms.** In qm, a grant applies in a shared
  Slack channel only if *everyone present* may see it. OfflineGPT workspaces
  have one person each, so there is no shared audience to check. Take this
  over if shared sessions arrive.
- **Read vs write on grants.** qm grants say `read` or `write`. Here the
  resource kinds already carry what "use" means, and Den's grant tables keep
  their own viewer/editor roles. Add a level only for a resource that needs
  both.
- **Principal links** (one person with several sign-ins). In the air-gapped
  edition, SSO plus SCIM give every person one identity.
- **Approving in Slack.** There is no Slack in an air-gapped network.
  Approvals happen in Den Web.
- **Model-run decision hooks** (allow or block chosen by a model at turn
  start or end). These are not deterministic permissions, and the regulated
  customers this edition is for need rules they can audit.

## Bugs found and fixed on the way

- `apps/server/src/schedule/timing.ts` imported `rrule` as a default export.
  That works under Bun's dev runner but breaks the compiled `offlinegpt-server`
  binary (also used by the desktop sidecar).
- `PATCH /runtime-config/providers` failed with `opencode_unconfigured` on a
  v2-only server, because it always reloaded the v1 engine. Den treats that as
  a failed workspace. v2 mirrors providers itself, so that reload is now
  skipped.
- den-db's `tsup` config and package exports still listed the deleted
  `remote-session-commands` schema, which broke the den-db build.
- The evals Den harness and den-db's asset build spawned `pnpm` without a
  shell, which fails on Windows.
- An unused Saved Apps fixture in `evals/worlds/library.ts` imported a deleted
  module.
- The full-stack run (2026-11-25) found and fixed:
  - **Employees could not get a workspace.** Den's browser path
    (`/v1/cloud/instance`, `/v1/cloud/gateway/resolve`) worked only in
    multi-org mode with Daytona. It now resolves Docker workspaces by their
    fixed internal URL, and waking or recovering a workspace uses the Docker
    provisioner instead of calling Daytona.
  - **The app sent employees to the hosted sign-in site** (`app.offlinegptlabs.com`).
    The gateway now tells the app which Den web to use (`DEN_GATEWAY_DEN_WEB_URL`).
    Den also accepts the sign-in return to the configured gateway in the
    air-gapped edition.
  - **Self-hosted models could not be turned on.** Enabling OfflineGPT Models
    required a subscription and an OpenRouter key. In the air-gapped edition
    it needs neither, and members' provider uses the plain OpenAI-compatible
    client.
  - **Workspaces had no models.** OpenCode v2 does not fill a custom
    provider's models from the catalog, so Den now delivers the gateway's
    model list with the provider. The gateway's catalog comes from
    configuration, so it is there before vLLM finishes loading.
  - **Den could not read a v2-only workspace's providers**
    (`GET /opencode/config` returned 400), which failed every model delivery.
  - **Only one workspace per organization** (the hosted default cap). The cap
    does not apply in the air-gapped edition.
  - **Web access was reported inconsistently** (`complimentary` without
    `complimentaryAccess`), so the app stayed locked.
  - **All employees shared one sign-in rate limit**, because den-api could
    not see client IPs behind its proxies. It now trusts the internal subnet.
  - **Compose wiring:** the `/setup` owner email, trusted origins for Den
    web, Den web's own URLs, a published den-api port for Den web,
    migrations through the production runner, and a context length that
    fits OpenCode's prompt.
  - **`Dockerfile.den`** still copied the removed `packages/automations`
    workspace and could not build.
- Fresh installs build the schema from a drizzle snapshot, which cannot hold
  a FULLTEXT index. den-db's schema repairs now create the knowledge search
  index there, so fresh and upgraded databases match.

## Not done yet

- **Sign-in on plain HTTP** uses the copy-and-paste sign-in code. With HTTPS
  and `OFFLINEGPT_GATEWAY_ORIGIN` set, sign-in returns straight to the app,
  but that path has not been run here (the local stack was HTTP).
- **Den web's sign-in page** still shows the hosted marketing copy ("OpenAI ·
  Anthropic · Google").
- **Usage accounting for self-hosted models**: limits still gate requests, but
  usage settlement comes from OpenRouter's webhook, so self-hosted tokens are
  not yet counted. Counting `usage` from vLLM's responses is the follow-up.
- **Billing screens** are still visible in the air-gapped edition.
- **Knowledge base**:
  - only text and Markdown can be added, so PDF and Word need converting
    first;
  - search is keyword full-text, not semantic. Embeddings from a self-hosted
    embedding model are the follow-up;
  - documents are added by owners and super-admins only. There is no separate
    "knowledge editor" role yet.
- **Access requests**:
  - approvers see requests in Den Web only, with no email or chat
    notification (email is disabled in the air-gapped edition anyway);
  - the agent cannot file a request itself. It tells the member to use the
    request form.
- **Lab doc items** (`docs/self-hosted-inference-lab.md`): the Semantic Router
  and the GPU manager are later phases.
