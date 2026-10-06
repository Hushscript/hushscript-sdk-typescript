import { OPERATION_SCOPES } from "../generated/scopes.ts";
import { EXPLICIT_CLASSES, retryClassFor, type RetryClass } from "./retry.ts";

interface Template {
  key: string;
  method: string;
  pattern: RegExp;
  params: number;
}

function compile(key: string): Template {
  const space = key.indexOf(" ");
  const method = key.slice(0, space);
  const path = key.slice(space + 1);
  const params = path.match(/\{[^{}]+\}/g)?.length ?? 0;
  const pattern = path
    .split(/\{[^{}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join("[^/]+");
  return { key, method, pattern: new RegExp(`^${pattern}$`), params };
}

// Fewest parameters first, so /v1/transcripts/deleted beats /v1/transcripts/{id}.
const TEMPLATES: readonly Template[] = [
  ...new Set([...Object.keys(OPERATION_SCOPES), ...Object.keys(EXPLICIT_CLASSES)]),
]
  .map(compile)
  .sort((a, b) => a.params - b.params);

/** `METHOD /path/template` for a concrete request, or `METHOD /path` when no template matches. */
export function operationFor(method: string, pathname: string): string {
  const verb = method.toUpperCase();
  const match = TEMPLATES.find((t) => t.method === verb && t.pattern.test(pathname));
  return match?.key ?? `${verb} ${pathname}`;
}

/** Same as `operationFor`, for an operation string that already reads `METHOD /path`. */
export function resolveOperation(operation: string): string {
  const space = operation.indexOf(" ");
  return operationFor(operation.slice(0, space), operation.slice(space + 1));
}

/** The retry class of a concrete request, from its method and URL path alone (spec 7.4). */
export function retryClassForRequest(method: string, pathname: string): RetryClass {
  const operation = operationFor(method, pathname);
  return retryClassFor(method, operation.slice(operation.indexOf(" ") + 1));
}
