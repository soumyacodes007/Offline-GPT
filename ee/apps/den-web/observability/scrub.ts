import type { JsonObject, JsonValue } from "@offlinegpt-ee/utils/observability";

const redacted = "[redacted]";
const redactedQuery = "[redacted-query]";
const sensitiveKeyPattern = /(authorization|cookie|credential|secret|token|password|passwd|api[_-]?key|session|set-cookie|csrf|jwt|bearer)/iu;
const sensitiveContainerKeyPattern = /(^|[_.-])(body|cookies?|data|headers?|payload|query|query_string|raw|request_body|response_body|search)([_.-]|$)/iu;

export type UnknownRecord = {
  readonly [key: string]: unknown;
};

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key) || sensitiveContainerKeyPattern.test(key);
}

export function shouldRedactTelemetryKey(key: string): boolean {
  return isSensitiveKey(key);
}

export function scrubText(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/giu, `$1?${redactedQuery}`)
    .replace(/(\/[A-Za-z0-9._~!$&()*+,;=:@%-][^\s"'<>?]*)\?[^\s"'<>]*/gu, `$1?${redactedQuery}`)
    .replace(/(["'])(authorization|cookie|credential|secret|token|password|passwd|api[_-]?key|session|set-cookie|csrf|jwt|bearer)(["']\s*:\s*)(["'])[^"']*\4/giu, `$1$2$3$4${redacted}$4`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${redacted}`)
    .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/giu, `Basic ${redacted}`)
    .replace(/\b(token|password|secret|api[_-]?key|session|cookie|body|payload|request_body|response_body)=([^\s&;]+)/giu, `$1=${redacted}`)
    .replace(/\b(body|payload|request_body|response_body):\s*[^\n\r]+/giu, `$1: ${redacted}`)
    .replace(/\b(cookie|set-cookie|authorization|x-api-key):\s*[^\n\r]+/giu, `$1: ${redacted}`);
}

function scrubJsonValue(key: string, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (isSensitiveKey(key)) return redacted;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubJsonValue(key, item) ?? null);
  if (typeof value === "object" && value !== null) return scrubLogFields(value);
  return value;
}

function scrubUnknownValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return redacted;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubUnknownValue(key, item));
  if (isUnknownRecord(value)) return scrubUnknownRecord(value);
  return value;
}

export function scrubLogFields(fields: JsonObject | undefined): JsonObject | undefined {
  if (fields === undefined) return undefined;

  const scrubbed: Record<string, JsonValue | undefined> = {};
  for (const [key, value] of Object.entries(fields)) {
    scrubbed[key] = scrubJsonValue(key, value);
  }
  return scrubbed;
}

export function scrubUnknownRecord(record: object | undefined): UnknownRecord | undefined {
  if (record === undefined) return undefined;

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    scrubbed[key] = scrubUnknownValue(key, value);
  }
  return scrubbed;
}

