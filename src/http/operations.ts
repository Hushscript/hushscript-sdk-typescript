import { OPERATION_SCOPES } from "../generated/scopes.ts";
import { EXPLICIT_CLASSES, retryClassFor, type RetryClass } from "./retry.ts";

interface Template {
  key: string;
  method: string;
  pattern: RegExp;
  /** The literal stretches around the parameters: one more than the parameter count. */
  pieces: number;
}

function compile(key: string): Template {
  const space = key.indexOf(" ");
  const literals = key.slice(space + 1).split(/\{[^{}]+\}/);
  const pattern = literals
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join("[^/]+");
  return {
    key,
    method: key.slice(0, space),
    pattern: new RegExp(`^${pattern}$`),
    pieces: literals.length,
  };
}

/**
 * The `METHOD /path/template` of `keys` a concrete request matches, if any. Fewest parameters
 * first, so /v1/transcripts/deleted beats /v1/transcripts/{id}.
 */
export function templateMatcher(
  keys: Iterable<string>,
): (verb: string, pathname: string) => string | undefined {
  const templates = [...new Set(keys)].map(compile).sort((a, b) => a.pieces - b.pieces);
  return (verb, pathname) =>
    templates.find((t) => t.method === verb && t.pattern.test(pathname))?.key;
}

const match = templateMatcher([...Object.keys(OPERATION_SCOPES), ...Object.keys(EXPLICIT_CLASSES)]);

/** `METHOD /path/template` for a concrete request, or `METHOD /path` when no template matches. */
export function operationFor(method: string, pathname: string): string {
  const verb = method.toUpperCase();
  return match(verb, pathname) ?? `${verb} ${pathname}`;
}

/** Same as `operationFor`, for an operation string that already reads `METHOD /path`. */
export function resolveOperation(operation: string): string {
  const space = operation.indexOf(" ");
  return operationFor(operation.slice(0, space), operation.slice(space + 1));
}

function hasIdempotencyKey(body: string | null): boolean {
  // Stryker disable next-line ConditionalExpression: JSON.parse(null) reads "null", which ends in false like no body
  if (body === null) return false;
  try {
    // Stryker disable next-line OptionalChaining: a null body throws on `.idempotency_key` and the catch answers false
    const key = (JSON.parse(body) as { idempotency_key?: unknown } | null)?.idempotency_key;
    return typeof key === "string" && key !== "";
    // Stryker disable next-line BlockStatement: an empty catch returns undefined, which the caller reads as false
  } catch {
    return false;
  }
}

/**
 * The retry class of a concrete request, from its method, URL path and, for an upload create, its
 * body. A create replays safely only with an idempotency key; without one it is
 * an ordinary mutation.
 */
export function retryClassForRequest(
  method: string,
  pathname: string,
  body: string | null = null,
): RetryClass {
  const operation = operationFor(method, pathname);
  const retryClass = retryClassFor(method, operation.slice(operation.indexOf(" ") + 1));
  return retryClass === "upload-create" && !hasIdempotencyKey(body) ? "mutate" : retryClass;
}
