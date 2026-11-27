# Rebuilding `ee/` from scratch: clean-room plan

Status: plan, not started. Branch for the work: `feat/platform-rewrite` (off `main`
once `feat/airgapped-edition` and `chore/remove-telemetry` land).

## 1. Why, and the two products

`ee/` (about 180k lines: den-api 93k, den-web 61k, landing 10k, den-db 5k, plus
inference, gateway, diagnostics and helpers) was written for a hosted,
multi-tenant SaaS with billing, resale of models and growth analytics. We ship
two things instead:

| Edition | Who runs it | What it is |
|---|---|---|
| **Desktop** | One person, on their own machine | The Electron app + `offlinegpt-server` + OpenCode. The user signs in with **their own AI subscription** (ChatGPT Plus/Pro, Claude Pro/Max) through OpenCode's provider sign-in. No account with us, no server, no telemetry. |
| **Workspace** | An organization (PSU) inside its own network, air-gapped | One Docker host: sign-in through the org's IdP (OIDC/SAML + SCIM), a browser workspace per employee, a self-hosted model (vLLM), qm-style permissions, request/approval flow, a permissioned knowledge base, audit. |

Neither needs Stripe, Polar, Loops, PostHog, Sentry, OpenRouter resale,
Daytona, a marketing site, multi-org tenancy or growth dashboards.

## 2. Licensing: why clean-room, and the rules

`ee/LICENSE` gives Different AI, Inc. ownership of every modification to `ee/`
and forbids copying, merging, publishing or distributing that code (production
use beyond 5 users needs their subscription). That includes our own air-gap work
on `feat/airgapped-edition` inside `ee/`. Code under `apps/`, `packages/`,
`evals/`, `docs/` and `scenarios/` is MIT.

So the new platform is written **clean-room**:

1. **Spec authors** may read anything, including `ee/`, and write behaviour
   specs in `docs/platform-spec/` describing *what* the system must do: inputs,
   outputs, states, errors, permissions. Specs contain no code, no identifiers
   copied from `ee/` (table, function or variable names) and no structure
   copied from `ee/` files.
2. **Implementers** work only from: the specs, MIT code in this repo, public
   protocol standards (OIDC, SAML, SCIM 2.0, OpenAI-compatible API, MCP),
   upstream OpenCode, and the journey specs in `evals/specs/**`. They do not
   open `ee/` while implementing. When a spec is unclear, they ask the spec
   author; they do not look it up in `ee/`.
3. The two roles are different people or different agent sessions. An agent
   session that has read `ee/` source must not write platform code.
4. Every platform PR states in its description which spec it implements and
   that `ee/` was not consulted.
5. The new code lives outside `ee/` (`platform/`), is MIT, and has no
   dependency on any `@offlinegpt-ee/*` package.
6. At cutover, `ee/` is deleted from the default branch. The external contracts
   (URLs the desktop app calls) are re-specified from the MIT client code in
   `apps/app`, which is ours.
7. Before the first platform release, a lawyer reviews the process and a
   sample of specs and PRs.

The behaviour we keep is mostly described already in MIT material: the
journey specs in `evals/specs/` and the docs in `docs/` and `packages/docs/`.
Specs cite those first.

## 3. What exists today and what happens to it

| `ee/` part | Today | Decision |
|---|---|---|
| den-api auth (Better Auth, email/password, social, desktop hand-off) | Multi-org, verification flows, social sign-in | **Rebuild**: OIDC + SAML sign-in, SCIM provisioning, local break-glass admin, desktop/browser hand-off code. No social sign-in or public sign-up. |
| Orgs, members, teams, roles, invitations | Multi-org with active-org switching | **Rebuild single-tenant**: one organization per deployment; teams come from SCIM groups; built-in roles owner / admin / member plus custom roles. |
| Access policy rules, access requests, approvals | Added on our air-gap branch | **Rebuild** as the core `policy` package (section 5.3). |
| Knowledge base (per-section rules, sensitivity, search) | Added on our air-gap branch | **Rebuild**, plus PDF/Word ingestion and optional embeddings. |
| Inference proxy (per-member keys, catalog, usage) | Built for OpenRouter resale plus self-hosted | **Rebuild as `model-gateway`**: OpenAI-compatible, vLLM/Ollama upstreams only, per-member keys, quotas, usage records. No billing or webhook settlement. |
| Workers / cloud workers (Daytona, Render, Docker) | Hosted worker fleet | **Rebuild Docker-only** provisioner: one container per member, checkpointing, wake/idle/stop, leaver cleanup. |
| den-gateway (browser app proxy) | Routes the employee UI to their workspace | **Rebuild** inside the control service; there's no separate service. |
| MCP gateway (capabilities, connectors, plugins, marketplaces) | Large, many sources | **Rebuild a smaller version**: an org library of skills, plugins and MCP connections, governed by policy and exposed to workspaces through one MCP endpoint. Drop public marketplaces and hosted connector presets. |
| Desktop policies | Enterprise-gated config pushed to desktops | **Rebuild** as workspace policies applied to each member's workspace engine (same keys where the MIT app already reads them). |
| Audit events | Partial | **Rebuild** as an append-only log written by every mutation, plus an export. |
| den-web (Next.js dashboard) | 61k lines, hosted and admin in one app | **Rebuild** a smaller admin console and member "My access" page. |
| den-db (Drizzle, MySQL, about 100 migrations) | Migration history plus a bootstrap snapshot | **Rebuild** with a fresh schema and a single baseline migration. |
| Billing (Stripe, Polar), Loops, landing site, diagnostics app, den-admin-mcp, models analytics export, enterprise mock lab, telemetry packages | Hosted business | **Drop.** |
| Helm chart, GKE/EKS/AKS guides | Kubernetes | **Drop** (single Docker host is the supported deployment). Revisit only if a customer asks. |

## 4. Principles for the new code

- **Single-tenant.** One deployment is one organization. There are no org ids in
  URLs and no active-org switching. This removes a large class of bugs and code.
- **Deny by default.** Every route declares its permission. An unannotated route
  fails the build (a test that scans the route table).
- **One schema, many uses.** Each request and response is one Zod schema. The
  OpenAPI document, the TypeScript client for the console and the MCP tool list
  are generated from it.
- **Small modules with clear seams.** Domain packages (`identity`, `policy`,
  `knowledge`, `workspaces`, `models`, `audit`) have no HTTP or database
  imports in their core; adapters live at the edge. No file over ~400 lines.
- **Plain TypeScript, no `any`, no casts**, Drizzle for data, Hono for HTTP,
  React + TanStack Query + shadcn/ui (Base UI) for the console.
- **No hosted leftovers.** No feature flags for billing, plans, entitlements,
  regions or multi-org.
- **Zero telemetry.** Nothing is sent anywhere unless an admin configures an
  export to a destination they own (OTLP or syslog). This is enforced by the
  outbound-access check in CI (`scripts/check-outbound-access.mjs`) covering
  `platform/` too.
- **Air-gap first.** All assets are bundled: fonts, icons, the model catalog,
  docs. Startup never needs the internet. An egress-deny journey spec runs on
  every PR.
- **Proof is journey specs** in `evals/specs/**`, per `AGENTS.md`.

## 5. Target architecture (Workspace edition)

```
           employee browser                      admin browser
                 │                                    │
         ┌───────▼────────────────────────────────────▼───────┐
         │ control (Hono, one process)                        │
         │  identity · policy · requests · knowledge · audit  │
         │  workspace router (/w/*) · org library · MCP       │
         └──┬─────────────┬──────────────┬────────────────┬───┘
            │             │              │                │
        Postgres     Docker socket   model-gateway     IdP (OIDC/SAML, SCIM)
       (or MySQL)        │           (OpenAI-compatible)
                  per-member workspace     │
                  containers (offlinegpt-   vLLM / Ollama
                  server + OpenCode)
```

Three images: `control`, `model-gateway`, `workspace`. Plus the database and
vLLM. One `docker compose up`.

### 5.1 `identity`
- OIDC (auth code + PKCE) and SAML 2.0 SP sign-in; SCIM 2.0 Users and Groups
  endpoints; groups map to teams.
- First-admin bootstrap with a one-time setup code (no SMTP needed).
- Sessions in the database, short-lived, revocable; SCIM deactivation revokes
  sessions, inference keys and workspace access within one minute.
- Browser hand-off for the workspace UI; HTTPS redirect and copy-paste code paths
  are both journey-tested.

### 5.2 Organization model
- Members, teams (from SCIM or manual), roles: `owner`, `admin`, `member`,
  plus custom roles made of named permissions.

### 5.3 `policy` (the qm-style core)
- A rule is (resource kind, resource id or `prefix*`, principal: member, team,
  role or everyone, effect: allow or deny, optional expiry, reason).
- Decision: an explicit deny wins; an allow restricts the resource to its
  grantees; otherwise the kind's baseline (`open`, `closed`, `granted`) applies.
- Kinds: model, capability, plugin, skill, MCP connection, knowledge document,
  knowledge section, workspace setting.
- Decisions are checked at use time (model call, tool call, knowledge read),
  never cached across rule changes.
- "Check access" explains a decision: which rule matched and why.

### 5.4 Requests and approvals
- A member requests access with a purpose and a duration (1, 7, 30, 90 days or
  until removed). Approvers are owners or admins with the approve permission,
  never the requester. Approval is an atomic state change that writes an
  expiring allow rule. Unanswered requests expire after 7 days. Every step is
  audited.

### 5.5 `knowledge`
- Upload Markdown, text, PDF, Word. Documents are split into sections. A
  document is closed by default; its audience is a set of allow rules.
  Sections can be hidden or narrowed and carry a sensitivity label (ordinary,
  sensitive, restricted).
- Search: full-text first; optional embeddings served by the local model host.
  Results are filtered by policy for the asking member at query time.
- Exposed to workspaces as an MCP tool; sensitive reads are audited.

### 5.6 `models` (model-gateway service)
- OpenAI-compatible `/v1/chat/completions` and `/v1/models`.
- Upstreams: vLLM or Ollama inside the network, configured in a file; the model
  list is declared, so it is available before the upstream finishes loading.
- Per-member keys issued by `control`; the gateway checks the key and the model
  policy on every call, and records usage per member and model, with optional
  per-member or per-team daily token quotas.
- The admin usage page reads these records. No client telemetry is involved.

### 5.7 `workspaces`
- One container per member from the `workspace` image, created on first use,
  stopped when idle, woken on request.
- Files on a per-member volume with periodic checkpoints; recovery restores the
  latest checkpoint.
- The control service injects the member's model provider, org library and
  workspace policies when it starts the container.
- Leavers: on SCIM deactivation the container is stopped and its volume is
  kept for the retention period, then deleted (configurable).

### 5.8 Org library and MCP
- Admins publish skills, plugins and MCP server definitions. Policy decides who
  sees what. Workspaces get one MCP endpoint that lists and runs only what the
  member may use.

### 5.9 `audit`
- An append-only table written by every mutation and every sensitive read, with
  who, what, when, from where and the decision. There is a console view, and
  export as JSONL or to syslog.

### 5.10 Console (admin web)
- People and teams, Access (rules, requests, check access), Knowledge, Models
  and usage, Workspaces, Library, Audit, Settings (IdP, SCIM, policies).
- Members get "My access" (what I can use, my requests).

## 6. Desktop edition

The MIT app no longer imports any `ee/` package (checked on
`chore/remove-telemetry`). Remaining work:

1. **Own subscription first-run**: the welcome flow offers "Sign in with
   ChatGPT" and "Sign in with Claude" (OpenCode's provider sign-in) as the
   default path, then API keys and local models as alternatives. No OfflineGPT
   account.
2. **Hide hosted surfaces** in the desktop build: OfflineGPT Cloud sign-in,
   OfflineGPT Models purchase, cloud workers, hosted MCP gateway links. They
   come back only when the app is pointed at a Workspace deployment.
3. **Connect to a Workspace** (optional): a desktop user in a PSU can point the
   app at their organization's `control` URL to receive models, library and
   policies. This uses the same contract as the browser workspace.
4. **No telemetry**: done on `chore/remove-telemetry` (PostHog key, Sentry,
   usage telemetry and the analytics toggle removed). Keep it enforced with the
   outbound-access check.

## 7. Phases

Each phase ends with its journey specs passing via `pnpm evals:pr` /
`pnpm evals:e2e`. Phases 1–6 run in parallel with today's `ee/` stack. Nothing
switches until phase 8.

| # | Phase | Delivers | Exit proof |
|---|---|---|---|
| 0 | Spec extraction | `docs/platform-spec/*.md` for each module in section 5, written by spec authors | Specs reviewed; each lists its journey specs |
| 1 | Skeleton + identity | `platform/` workspace, `control` with OIDC/SAML/SCIM, bootstrap, sessions, Postgres schema baseline, route-permission test | Sign-in via a mock OIDC IdP and SAML IdP; SCIM create/deactivate; first-admin setup |
| 2 | Policy, requests, audit | `policy` package, rules API, check-access explainer, requests and approvals, audit log | Journey specs for deny-wins, team allow, expiry, approve/decline, self-approval refused |
| 3 | Model gateway | `model-gateway` image, per-member keys, policy on model calls, usage, quotas | Chat answered by vLLM (small model on the GPU) through a member key; denied model refused; quota enforced |
| 4 | Workspaces | Docker provisioner, workspace router, checkpointing, leaver flow | Employee signs in, gets their own container, chats with the self-hosted model in Chrome; container killed → work restored |
| 5 | Knowledge + library + MCP | Ingestion (MD, TXT, PDF, DOCX), sections, search, MCP tools, org library | A restricted section is invisible to a member without a section rule; a sensitive read is audited; a library skill appears only to allowed teams |
| 6 | Console | Admin console and "My access" | Console journey specs (`*.e2e.test.ts`) for each screen |
| 7 | Desktop edition | Own-subscription first run, hosted surfaces hidden, optional Workspace connection | Desktop e2e: fresh install → sign in with own subscription → task runs; egress-deny spec passes |
| 8 | Cutover | Compose file and docs for the new stack, data import from the current air-gap stack (if any customer data exists), `ee/` deleted | Full-stack spec on a clean host with egress denied; legal review signed off |

Rough size: the new platform should land around 25–35k lines, against about
180k today, because the hosted, multi-tenant and billing paths are gone.

## 8. Open questions

1. **Database**: Postgres (most common in PSU IT, better full-text and
   `pgvector`) or keep MySQL (matches today's stack)? This plan assumes Postgres.
2. **Spec authors vs implementers**: who plays each role? For agents, it must be
   separate sessions, and implementer sessions must not read `ee/`.
3. **Product name and licence** for `platform/`: MIT like the rest of the repo,
   or a different licence for the Workspace edition?
4. **Data migration**: is there any existing deployment of the current
   air-gapped stack whose data must be imported, or is it a fresh start?
5. **Desktop "Connect to a Workspace"**: needed in the first release, or
   browser-only for PSUs at first?
