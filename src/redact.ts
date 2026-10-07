import { inspect } from "node:util";

export const REDACTED = "hsr…[redacted]";

const TOKEN_SHAPE = /hsr\d+:[a-z]+:pat\.[0-9a-f]+\.[0-9a-f]+/g;
// Shorter than any real token; keeps a stray tiny string from turning every message into noise.
const MIN_SECRET_LENGTH = 8;
// A fragment of a token (what follows "pat.", or the secret after the last dot) is redacted only when
// it is long enough not to turn an ordinary short substring into noise.
const MIN_SECRET_TAIL = 16;

const secrets = new Set<string>();

/** Remembers a token verbatim, so it is redacted even if the token format changes. */
export function registerSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) return;
  remember(secret);
  // An API that echoes only what follows "pat." (the id and the secret), or only the secret after
  // the last dot, leaks the token as much as the whole string does.
  const marker = secret.indexOf("pat.");
  if (marker === -1) return;
  const tail = secret.slice(marker + "pat.".length);
  for (const part of [tail, tail.slice(tail.lastIndexOf(".") + 1)]) {
    if (part.length >= MIN_SECRET_TAIL) remember(part);
  }
}

function remember(secret: string): void {
  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
}

/** Forgets every remembered token; for tests that push random strings through a token path. */
export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.replaceAll(secret, REDACTED);
  return out.replace(TOKEN_SHAPE, REDACTED);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactValue(item)]),
    );
  }
  return value;
}

/** A copy of a wrapped cause that is safe to print: message, stack and nested cause redacted. */
export function redactCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return redactValue(cause);
  const copy = new Error(redact(cause.message));
  copy.name = cause.name;
  if (cause.stack !== undefined) copy.stack = redact(cause.stack);
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") Object.assign(copy, { code });
  if (cause.cause !== undefined) copy.cause = redactCause(cause.cause);
  return copy;
}

/**
 * Keeps `field` readable on a result that hands the caller a secret, but prints it as REDACTED in
 * `inspect`, `console.log`, `String()` and template strings. `JSON.stringify` still carries it: that
 * is the caller's own export. Both hooks are non-enumerable, so equality and spreads ignore them.
 */
export function withRedactedField<T extends object>(name: string, value: T, field: keyof T): T {
  const printable = (): object => ({ ...value, [field]: REDACTED });
  Object.defineProperty(value, inspect.custom, { value: printable });
  Object.defineProperty(value, "toString", {
    value: () => `${name} ${JSON.stringify(printable())}`,
  });
  return value;
}
