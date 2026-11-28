# Platform spec: SAML sign-in

For organizations whose identity provider offers SAML 2.0 but not OpenID
Connect. It works alongside OIDC and password sign-in; the same member rules
apply.

## Setup

- Settings: `SAML_ENTRY_POINT` (the IdP's single sign-on URL), `SAML_IDP_CERT`
  (the IdP's signing certificate, PEM or bare base64), optional
  `SAML_ENTITY_ID` (defaults to `<PUBLIC_URL>/auth/saml/metadata`) and
  `SAML_JIT`. Set the first two together or neither.
- `GET /auth/saml/metadata` serves this service's metadata XML, for the IdP
  admin to import.

## Signing in

- `GET /auth/saml/start` redirects to the IdP with a signed-in-request ID.
- The IdP posts back to `POST /auth/saml/acs`. The response is accepted only
  when:
  - the assertion is signed by the configured certificate;
  - it answers a request this service started (unsolicited responses and
    replays are refused);
  - its audience is this service and its time window is current (two
    minutes of clock skew allowed).
- The person is identified by the assertion's NameID; the email comes from the
  `email`/`mail` attribute (or the standard email claim URI), else from the
  NameID when it is an email address.
- Matching, just-in-time creation and refusal follow the OIDC rules: a member
  whose identity provider ID matches, else whose email matches; a new member
  only when `SAML_JIT=1`; an inactive or unknown person is refused. Every
  outcome is audited.
