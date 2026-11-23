# Air-gapped edition

Status: first working version on `feat/airgapped-edition` (2026-11-24). Every
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

A rule gives or removes access to one resource, or to every resource of a kind
(`resourceId: "*"`), for one **principal**:

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

**Admin API** (owner or super-admin for writes, admin for reads):

```
GET    /v1/access-policy/rules[?resourceKind=model]
POST   /v1/access-policy/rules   { resourceKind, resourceId, principalKind, principalId, effect, expiresAt?, reason? }
DELETE /v1/access-policy/rules/:ruleId
POST   /v1/access-policy/check   { memberId, resourceKind, resourceId }  → the decision and the member's principals
```

**Audit**: rule creation and removal are org audit events
(`organization.access_policy.rule_created` / `rule_removed`), and a denial of
something a member was otherwise granted (or a model refusal) is recorded as
`access_policy.denied` with the rule, resource, surface and reason.

### 4. Leavers lose access at once

When a member is removed by an admin or deprovisioned by SCIM:

- their inference keys stop working on the next request (`401`);
- every workspace token is revoked;
- their workspace container is stopped, with files kept for retention.

This runs on top of the existing removal steps (API keys, sessions, connected
accounts). See `ee/apps/den-api/src/workers/member-offboarding.ts`.

### 5. One workspace per employee (`PROVISIONER_MODE=docker`)

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

### 6. Packaging

| File | What |
|---|---|
| `packaging/docker/Dockerfile.workspace-airgapped` | Workspace image: offlinegpt-server, the web UI, v1 and v2 plugins, and the pinned OpenCode v2 engine verified by SHA-256 at build time. It runs as a non-root user. |
| `packaging/docker/docker-compose.airgapped.yml` | The whole stack on one host: MySQL, Redis, den-api, den-web, den-gateway, inference, vLLM (GPU), on the internal network |
| `packaging/helm/offlinegpt-ee` | `config.edition`, `config.inference.upstreamUrl` / `models`, an optional in-cluster `vllm` (model from a PVC); example `examples/values.airgapped.yaml` |
| `scripts/airgap-bundle.mjs` | On a connected machine: builds and pulls every image, `docker save`s them, adds the compose file and optional model weights, writes `SHA256SUMS` and an `install.sh` that verifies and `docker load`s inside the isolated network |

## Deploying (one host)

On a machine with internet access:

```
node scripts/airgap-bundle.mjs --out ./offlinegpt-airgapped --models /path/to/Qwen2.5-0.5B-Instruct
```

Move `./offlinegpt-airgapped` into the isolated network, then:

```
./install.sh
cat > .env <<'EOF'
OFFLINEGPT_PUBLIC_URL=https://offlinegpt.example.internal
OFFLINEGPT_MYSQL_PASSWORD=...
OFFLINEGPT_AUTH_SECRET=...            # 32+ characters
OFFLINEGPT_DB_ENCRYPTION_KEY=...      # 32+ characters
OFFLINEGPT_GATEWAY_KEY=...            # 32+ characters
OFFLINEGPT_ADMIN_BOOTSTRAP_CODE=...   # one-time code for /setup
EOF
OFFLINEGPT_MODELS_DIR=$PWD/models docker compose -f docker-compose.airgapped.yml up -d
```

Then open `$OFFLINEGPT_PUBLIC_URL/setup`, enter the bootstrap code, connect SSO
and SCIM (Admin → Identity), and add access policy rules.

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
| `evals/specs/access-policy-admin.test.ts` | Rule writes guarded (`403` member, `400` bad principal or kind); a member deny hides an org-wide MCP connection from one member only; `/check` names the rule; removal restores access; audit holds created then removed | Passed |

Run them with:

```
pnpm evals:pr specs/airgapped-inference.test.ts
OFFLINEGPT_EVAL_VLLM_URL=http://127.0.0.1:8000/v1 pnpm evals:pr specs/airgapped-inference.test.ts
pnpm evals:pr specs/airgapped-workspace.test.ts          # needs the workspace image
OFFLINEGPT_EVAL_DEN_RUNTIME_PREPARED=1 pnpm evals:pr specs/access-policy-admin.test.ts   # Windows: prepared runtime
```

The unit and route tests next to the code also pass: edition parsing; den-api
env refusals; the policy evaluator; Docker provisioner calls; inference proxy
and catalog (80/80).

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

## Not done yet

- **Kubernetes workspaces**: on Kubernetes, the chart runs Den, inference and
  vLLM, but per-employee workspaces need a `PROVISIONER_MODE=kubernetes`
  provisioner (Pods and PVCs). Today they run on a Docker host.
- **Full-stack compose run**: the compose file validates (`docker compose
  config`), and each part is proven separately. A single `up` of every service,
  including den-web and den-gateway images built for the edition, has not been
  run yet.
- **Usage accounting for self-hosted models**: limits still gate requests, but
  usage settlement comes from OpenRouter's webhook, so self-hosted tokens are
  not yet counted. Counting `usage` from vLLM's responses is the follow-up.
- **den-web screens**:
  - the access policy has an API but no admin page yet;
  - billing screens are still visible in the air-gapped edition.
- **More policy surfaces**:
  - `llm_provider` and `capability` kinds exist in the table but are refused by
    the API until they are enforced;
  - scheduled tasks re-check policy only through the model and connection
    checks they hit at run time.
- **Lab doc items** (`docs/self-hosted-inference-lab.md`): the Semantic Router,
  the GPU manager, and the knowledge base with per-chunk ACLs are later phases.
