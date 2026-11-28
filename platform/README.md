# OfflineGPT platform (Workspace edition)

The Workspace edition, written from scratch under MIT. An organization runs it
on one Docker host inside its own network: employees sign in with the
organization's identity provider, get a private AI workspace, and use a
self-hosted model. Admins control who can use which model, document and tool,
approve access requests, and read the audit log. Nothing is sent outside the
network, and there is no telemetry.

Behaviour specs: [`docs/platform-spec/`](../docs/platform-spec/). Plan:
[`docs/rewrite/clean-room-plan.md`](../docs/rewrite/clean-room-plan.md).

## Parts

| Path | What |
|---|---|
| `apps/control` | The main service (Bun + Hono). Sign-in (first-owner setup, OIDC with PKCE, break-glass password), SCIM 2.0, access rules and "check access", access requests and approvals, audit log, knowledge base and search, per-employee Docker workspaces and the `/w/` router, an MCP endpoint for workspaces, and it serves the console. |
| `apps/console` | The web console (React). Employees: start their workspace, search knowledge, ask for access. Admins: Access, People, Knowledge, Usage, Audit log. |
| `apps/model-gateway` | OpenAI-compatible endpoint in front of vLLM or Ollama: per-member keys, model permissions, streaming, usage records, optional daily token limit. |
| `packages/policy` | The access decision engine (pure; deny wins, allow restricts, expiry, `prefix*`, explained causes). |
| `packages/access` | Loads rules and members for the engine; resource kinds and their defaults. |
| `packages/db` | Postgres schema and migrations (Drizzle). Runs on a Postgres server or embedded PGlite. |

## Run it

```bash
cp packaging/platform/.env.example packaging/platform/.env      # fill it in
docker compose -f packaging/platform/docker-compose.yml --env-file packaging/platform/.env --profile build build
docker compose -f packaging/platform/docker-compose.yml --env-file packaging/platform/.env up -d
```

Then open `PUBLIC_URL`, choose **First-time setup**, and enter `OWNER_EMAIL`,
`SETUP_CODE` and a password. Next:

1. **People** → make a SCIM token and paste it into your identity provider's
   provisioning settings, with the SCIM URL `<PUBLIC_URL>/scim/v2`.
2. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` and restart,
   so employees sign in with single sign-on.
3. **Knowledge** → add documents and choose who can read them.
4. **Access** → add rules, and approve requests as they come in.

## Develop

```bash
pnpm install
pnpm --filter "./platform/**" test        # unit and route tests (embedded Postgres, no Docker needed)
DATABASE_URL=pglite:./tmp/control PUBLIC_URL=http://localhost:8790 OWNER_EMAIL=you@example.test \
  SETUP_CODE=dev-setup-code-123456 CONSOLE_DIR=platform/apps/console/dist bun platform/apps/control/src/main.ts
```

The console journey spec runs in Chrome against a running control service:

```bash
cd evals && OFFLINEGPT_EVAL_E2E_TESTS=1 OFFLINEGPT_EVAL_PLATFORM_URL=http://localhost:8790 \
  OFFLINEGPT_EVAL_PLATFORM_OWNER_EMAIL=you@example.test OFFLINEGPT_EVAL_PLATFORM_SETUP_CODE=dev-setup-code-123456 \
  pnpm exec vitest run --config vitest.config.ts --project e2e specs/platform-console.e2e.test.ts
```

## Verified

`evals/specs/platform-stack.e2e.test.ts` passed against this compose file on a
single GPU host (RTX 3050, Qwen 2.5 0.5B): the owner signs in on the console,
starts their workspace, the workspace app opens on its own port, and a task
sent in the browser is answered by vLLM through the model gateway with the
member's own key.

## Not done yet

- SAML sign-in (OIDC works).
- Library: skills, shared MCP connections and plugins (Claude plugin `.zip`) are done.
