import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const key = await derive(password, Buffer.from(salt, "base64url"));
  const expectedKey = Buffer.from(expected, "base64url");
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}
