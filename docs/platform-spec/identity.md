# Platform spec: identity

Phase 0 behaviour spec for sign-in, sessions and directory sync in the
`control` service. One deployment is one organization.

## People

- A **member** has an email (unique, compared case-insensitively), a name, a
  role (`owner`, `admin` or `member`), an active flag and, when they came from
  the IdP, the IdP's stable id.
- Inactive members cannot sign in, and every session they hold stops working
  at once.
- There is always at least one active owner. Changes that would remove the
  last active owner are refused.

## First owner

- While the deployment has no members, `POST /setup` with the configured
  owner email, the one-time setup code, a name and a password creates the
  first owner and signs them in.
- The code is compared in constant time. The email must match the configured
  owner email. After the first member exists, `/setup` answers 409 forever.
- This local password is the break-glass account. Everyone else signs in
  through the IdP.

## Sessions

- Signing in returns an opaque bearer token and sets the same token as an
  HTTP-only, `SameSite=Lax` cookie (`Secure` when the public URL is HTTPS).
- Only a hash of the token is stored. Sessions last 12 hours (configurable),
  and `POST /auth/logout` ends the current one.
- A request is authenticated by `Authorization: Bearer <token>` or the cookie.

## OIDC sign-in

- `GET /auth/oidc/start` redirects to the IdP's authorization endpoint with
  the code flow, PKCE (S256), a random `state` and a `nonce`, all bound to a
  short-lived, HTTP-only cookie.
- `GET /auth/oidc/callback` checks `state`, exchanges the code, and verifies
  the ID token's signature (IdP JWKS), issuer, audience, expiry and nonce.
- The member is found by IdP id, then by email. When none exists, the member
  is created only if just-in-time sign-up is on (default: off, so SCIM decides
  who may sign in). An inactive member is refused.
- On success it creates a session and redirects to the app.

## SCIM 2.0 (directory sync)

- Base path `/scim/v2`, authenticated by a bearer token that an owner
  generates (only its hash is stored; regenerating it replaces the old one).
- Users: create, get, list with `filter=userName eq "..."`, replace, patch
  (`active`, `name`, `emails`), delete. Delete and `active: false` deactivate
  the member, end their sessions and keep their record for audit.
- Groups: create, get, list with `filter=displayName eq "..."`, patch members
  (add, remove, replace), delete. Groups are teams.
- Errors use the SCIM error format with the right status (400, 404, 409).

## Audit

Every sign-in, sign-out, setup, SCIM change, role change and rule change
writes an audit event with the actor (member id, `scim` or `system`), the
action and its details.

## Journey proof

`evals/specs/platform-identity.test.ts` must show, against a running control
service with a mock OIDC IdP:

- first-owner setup works once and then answers 409;
- a SCIM-created user signs in through OIDC; a user not in SCIM is refused;
- SCIM deactivation ends the user's live session;
- a wrong SCIM token is refused.
