import { describe, expect, test } from "bun:test";

import { buildAuthSessionCookieClearHeaders } from "./session-cookie-clear.ts";

describe("auth session cookie clearing", () => {
  test("clears host-only, app-host, and parent-domain session cookies", () => {
    expect(buildAuthSessionCookieClearHeaders("https://app.offlinegptlabs.com/api/auth/clear-session-cookie", "offlinegptlabs.com")).toEqual([
      "__Secure-offlinegpt-den.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax",
      "__Secure-offlinegpt-den.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=offlinegptlabs.com",
      "__Secure-offlinegpt-den.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=app.offlinegptlabs.com",
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax",
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=offlinegptlabs.com",
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=app.offlinegptlabs.com",
    ]);
  });

  test("normalizes a leading-dot configured cookie domain", () => {
    expect(buildAuthSessionCookieClearHeaders("https://app.example.com/api/auth/clear-session-cookie", ".example.com")).toContain(
      "__Secure-offlinegpt-den.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=example.com",
    );
  });
});
