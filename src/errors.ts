import { camelize } from "./camel.ts";
import { ERROR_CATALOG } from "./generated/catalog.ts";
import { HINTS } from "./generated/hints.ts";
import { OPERATION_SCOPES } from "./generated/scopes.ts";
import { resolveOperation } from "./http/operations.ts";
import { parseRetryAfter } from "./http/retry.ts";
import { redact, redactCause, redactValue } from "./redact.ts";

export interface ErrorInit {
  /** Slug: the API's own for API errors, the SDK's for SDK-side ones. */
  code: string;
  message: string;
  numericCode?: number | null;
  status?: number | null;
  /** Explicit hint text, or null for none. Left out, it comes from the shared hints table. */
  hint?: string | null;
  details?: Record<string, unknown>;
  retryAfter?: number | null;
  cause?: unknown;
  /** Values for `{placeholders}` in the shared hint text. */
  hintValues?: Record<string, unknown>;
}

type WithDefaultCode = Omit<ErrorInit, "code"> & { code?: string };

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fills a hint template: split after each ". ", drop every sentence
 * with a placeholder that has no value, join the rest with one space. Nothing left is null.
 */
function fillHint(template: string, values: Record<string, unknown>): string | null {
  const known = (name: string): boolean => values[name] !== undefined && values[name] !== null;
  const kept = template
    .split(/(?<=\.) /)
    .filter((sentence) => [...sentence.matchAll(PLACEHOLDER)].every((m) => known(m[1] ?? "")));
  if (kept.length === 0) return null;
  return kept.join(" ").replace(PLACEHOLDER, (_whole, name: string) => String(values[name]));
}

/** What an SDK has in hand for a hint, before rounding; seconds stay seconds. */
export interface HintInputs {
  scope?: string | undefined;
  neededSeconds?: number | undefined;
  balanceSeconds?: number | undefined;
  usedSeconds?: number | undefined;
  maxSeconds?: number | undefined;
  retryAfter?: number | null | undefined;
  allowedPacks?: readonly string[] | undefined;
  currentVersion?: string | number | undefined;
}

function minutes(seconds: number | undefined, round: (n: number) => number): number | undefined {
  return seconds === undefined ? undefined : round(seconds / 60);
}

/** Placeholder values for a hint: `{needed}` rounds up, the other minute values round down. */
export function hintValuesFrom(inputs: HintInputs): Record<string, unknown> {
  return {
    scope: inputs.scope,
    needed: minutes(inputs.neededSeconds, Math.ceil),
    balance: minutes(inputs.balanceSeconds, Math.trunc),
    used: minutes(inputs.usedSeconds, Math.trunc),
    max: minutes(inputs.maxSeconds, Math.trunc),
    retryAfter: inputs.retryAfter,
    allowedPacks: inputs.allowedPacks?.join(", "),
    currentVersion: inputs.currentVersion,
  };
}

/** The shared hint for `slug` filled from `values`, or null when it has none or nothing is left. */
export function renderHint(slug: string, values: Record<string, unknown>): string | null {
  const template = HINTS[slug];
  return template === undefined ? null : fillHint(template, values);
}

function resolveHint(init: ErrorInit): string | null {
  if (init.hint !== undefined) return init.hint === null ? null : redact(init.hint);
  const hint = renderHint(init.code, init.hintValues ?? {});
  return hint === null ? null : redact(hint);
}

export class HushscriptError extends Error {
  code: string;
  numericCode: number | null;
  status: number | null;
  hint: string | null;
  details: Record<string, unknown>;
  retryAfter: number | null;
  /** Set on an error `transcribe()` raised after its create was sent, or `buy()` after its purchase was sent: passing it back replays the same job or purchase instead of making a second one. */
  idempotencyKey: string | null = null;
  /** Set once the job id is known; `resume()` takes it. */
  resumeToken: string | null = null;

  constructor(init: ErrorInit) {
    super(
      redact(init.message),
      init.cause === undefined ? undefined : { cause: redactCause(init.cause) },
    );
    this.name = new.target.name;
    this.code = init.code;
    this.numericCode = init.numericCode ?? null;
    this.status = init.status ?? null;
    this.hint = resolveHint(init);
    this.details = redactValue(init.details ?? {}) as Record<string, unknown>;
    this.retryAfter = init.retryAfter ?? null;
  }
}

const MISSING_TOKEN_HINT =
  "Set HUSHSCRIPT_TOKEN or pass a token. Create one in the Hushscript app: Account → MCP (app.hushscript.com/account/mcp).";

export class ConfigurationError extends HushscriptError {
  constructor(init: WithDefaultCode) {
    super({ ...init, code: init.code ?? "config_invalid" });
  }

  static missingToken(): ConfigurationError {
    return new ConfigurationError({
      message: "No Hushscript token: set HUSHSCRIPT_TOKEN or pass a token.",
      hint: MISSING_TOKEN_HINT,
    });
  }
}

/** Raised before any request that holds credit; no hold was placed. */
export class PreflightError extends HushscriptError {}
export class UnsupportedMediaError extends PreflightError {}
export class FileLimitError extends PreflightError {}
export class DailyLimitError extends PreflightError {}
export class ResumeMismatchError extends PreflightError {}

/** Any non-2xx response not listed below; `status` is set. */
export class ApiError extends HushscriptError {}
export class AuthenticationError extends ApiError {}
export class PermissionDeniedError extends ApiError {}
export class InsufficientBalanceError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class ValidationError extends ApiError {}
export class RateLimitError extends ApiError {}

export class PaymentMethodRequiredError extends HushscriptError {
  constructor(init: WithDefaultCode) {
    super({ ...init, code: init.code ?? "no_default_card" });
  }
}

export class UploadError extends HushscriptError {}

export class JobFailedError extends HushscriptError {
  error: string | null;
  failureKind: "media_unreadable" | "media_undecodable" | null;
  jobId: string;

  constructor(
    init: WithDefaultCode & {
      error: string | null;
      failureKind: "media_unreadable" | "media_undecodable" | null;
      jobId: string;
    },
  ) {
    super({ ...init, code: init.code ?? "job_failed" });
    this.error = init.error === null ? null : redact(init.error);
    this.failureKind = init.failureKind;
    this.jobId = init.jobId;
  }
}

export class WaitTimeoutError extends HushscriptError {
  /** `resumeToken` is null only for `jobs.wait`, which has no idempotency key to build a token from. */
  constructor(init: WithDefaultCode & { resumeToken: string | null }) {
    super({ ...init, code: init.code ?? "wait_timeout" });
    this.resumeToken = init.resumeToken;
  }
}

export class AbortError extends HushscriptError {
  constructor(init: WithDefaultCode & { resumeToken?: string | null }) {
    super({ ...init, code: init.code ?? "aborted" });
    this.resumeToken = init.resumeToken ?? null;
  }
}

/** Raised after retries ran out on network errors or timeouts. */
export class NetworkError extends HushscriptError {
  constructor(init: WithDefaultCode) {
    super({ ...init, code: init.code ?? "network_error" });
  }
}

const OUTCOME_HINTS: Readonly<Record<string, string>> = {
  "POST /v1/agent/accounts/{signup_id}/claim":
    "The claim may have succeeded. Retrying will fail with agent_claim_invalid. If you have no token, contact support with the signup id.",
  "POST /v1/agent/credentials/rotate":
    "The old token may already be revoked. Try a request with it; if it fails, the new token was lost and the account needs support.",
};

/** The request was sent and no response arrived, for a call the server cannot repeat. */
export class OutcomeUnknownError extends HushscriptError {
  readonly #receivedToken: string | null;

  constructor(init: WithDefaultCode & { receivedToken?: string }) {
    super({ ...init, code: init.code ?? "outcome_unknown" });
    this.#receivedToken = init.receivedToken ?? null;
  }

  /**
   * The string a rotate answer carried as the new token when it was not a usable one, so a caller
   * can still look at (or rescue) it. A getter over a private field: it is left out of `inspect`,
   * `JSON.stringify` and every message. Null for every other outcome.
   */
  get receivedToken(): string | null {
    return this.#receivedToken;
  }

  static hintFor(operation: string): string | null {
    return OUTCOME_HINTS[operation] ?? null;
  }
}

const RATE_LIMIT_SLUGS: ReadonlySet<string> = new Set([
  "rate_limited",
  "too_many_active_jobs",
  "agent_purchase_capped",
  "url_target_busy",
]);
const BALANCE_SLUGS: ReadonlySet<string> = new Set([
  "insufficient_balance",
  "org_insufficient_balance",
  "org_pool_expired",
  "org_plan_frozen",
]);
const UPLOAD_SLUGS: ReadonlySet<string> = new Set(["upload_incomplete", "size_exceeded"]);

const JOB_OPERATION = /^\w+ \/v1\/(?:jobs|uploads)(?:\/|$)/;

type ErrorClass = new (init: ErrorInit) => HushscriptError;

function classFor(status: number, slug: string): ErrorClass {
  if (UPLOAD_SLUGS.has(slug)) return UploadError;
  if (RATE_LIMIT_SLUGS.has(slug)) return RateLimitError;
  if (BALANCE_SLUGS.has(slug)) return InsufficientBalanceError;
  switch (status) {
    case 400:
    case 422:
      return ValidationError;
    case 401:
      return AuthenticationError;
    case 402:
      return InsufficientBalanceError;
    case 403:
      return PermissionDeniedError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 429:
      return RateLimitError;
    default:
      return ApiError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function hintValuesFor(
  details: Record<string, unknown>,
  retryAfter: number | null,
  operation: string,
): Record<string, unknown> {
  const nested = isRecord(details["details"]) ? details["details"] : {};
  const packs = nested["allowedPacks"];
  const version = details["currentVersion"] ?? nested["currentVersion"];
  return hintValuesFrom({
    scope: OPERATION_SCOPES[resolveOperation(operation)],
    neededSeconds: numberOf(details["neededSeconds"]),
    balanceSeconds: numberOf(details["balanceSeconds"]),
    retryAfter,
    allowedPacks: Array.isArray(packs) ? (packs as string[]) : undefined,
    currentVersion:
      typeof version === "string" || typeof version === "number" ? version : undefined,
  });
}

/**
 * The typed error for a non-2xx response. `body` is the parsed JSON (or the raw text when it was
 * not JSON); `operation` is `METHOD /path` and selects the scope named in a permission hint.
 */
export function errorFromResponse(
  res: Response,
  body: unknown,
  operation: string,
): HushscriptError {
  const record = isRecord(body) ? body : {};
  const slug = typeof record["error"] === "string" ? record["error"] : null;
  const numericCode = Number.isInteger(record["code"]) ? (record["code"] as number) : null;
  const code = slug ?? `http_${String(res.status)}`;
  const extras = Object.entries(record).filter(([key]) => key !== "error" && key !== "code");
  const details = camelize(Object.fromEntries(extras)) as Record<string, unknown>;
  const nested = isRecord(details["details"]) ? details["details"] : {};
  const bodyRetry = nested["retryAfterSeconds"];
  const retryAfter =
    parseRetryAfter(res.headers.get("retry-after")) ??
    (typeof bodyRetry === "number" ? bodyRetry : null);
  const meaning = slug === null ? undefined : ERROR_CATALOG[slug]?.meaning;
  const message =
    meaning ??
    (slug === null
      ? `The API answered ${String(res.status)}.`
      : `${slug} (HTTP ${String(res.status)})`);
  const ErrorType = classFor(res.status, code);
  return new ErrorType({
    code,
    message,
    numericCode,
    status: res.status,
    details,
    retryAfter,
    // `wrong_state` names a job call, so only job and upload operations carry that hint.
    ...(code === "wrong_state" && !JOB_OPERATION.test(resolveOperation(operation))
      ? { hint: null }
      : {}),
    hintValues: hintValuesFor(details, retryAfter, operation),
  });
}
