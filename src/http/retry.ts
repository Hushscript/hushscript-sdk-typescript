/**
 * `safe`: GETs and heartbeats. `idempotent`: part PUTs and complete, which can be repeated after
 * any 5xx. `upload-create`: like idempotent plus pacing.
 */
export type RetryClass = "safe" | "idempotent" | "upload-create" | "purchase" | "never" | "mutate";

/** A Retry-After above this is never waited for. */
const MAX_RETRY_AFTER_SECONDS = 60;

const BACKOFF_CAP_MS = 8000;
const BACKOFF_BASE_MS = 500;
const PURCHASE_MAX_RETRIES = 1;
/** `rate_limited` without Retry-After on an upload create backs off 15, 30, 60 s, then raises. */
const CREATE_RATE_LIMIT_SCHEDULE_MS: readonly number[] = [15_000, 30_000, 60_000];
/** `too_many_active_jobs` waits 30 s between tries, up to 10 tries. */
const CREATE_ACTIVE_JOBS_WAIT_MS = 30_000;
const CREATE_ACTIVE_JOBS_RETRIES = 9;

/**
 * The retry class by `METHOD /path/template`. Everything that is neither listed here nor a GET or HEAD
 * mutates and is only retried when the request provably never left (`mutate`).
 */
export const EXPLICIT_CLASSES: Readonly<Record<string, RetryClass>> = {
  "POST /v1/uploads": "upload-create",
  "PUT /v1/uploads/{job}/parts/{n}": "idempotent",
  "POST /v1/uploads/{job}/heartbeat": "safe",
  "POST /v1/uploads/{job}/complete": "idempotent",
  "POST /v1/billing/purchase": "purchase",
  "POST /v1/billing/setup-session": "purchase",
  "POST /v1/agent/accounts/{signup_id}/claim": "never",
  "POST /v1/agent/credentials/rotate": "never",
  "POST /v1/agent/accounts": "never",
};

export function retryClassFor(method: string, template: string): RetryClass {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "safe";
  return EXPLICIT_CLASSES[`${verb} ${template}`] ?? "mutate";
}

/** Full jitter: random(0, min(8 s, 0.5 s * 2^attempt)), `attempt` counting from 0. */
export function backoffMs(attempt: number, random: () => number): number {
  return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** The most a reported retry-after can be: an integer past this, however long, is "over 60" and capped here. */
export const MAX_RETRY_AFTER_REPORTED: number = Number.MAX_SAFE_INTEGER;

/**
 * Whole seconds only. HTTP dates and anything else non-numeric count as absent; an integer of any
 * length is a real wait, so one past the safe integers is capped (and so is "over 60").
 */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (!/^\d+$/.test(text)) return null;
  return Math.min(Number(text), MAX_RETRY_AFTER_REPORTED);
}

export interface RetryInput {
  retryClass: RetryClass;
  /** HTTP status of the failed attempt, or null for a network error or timeout. */
  status: number | null;
  /** Whether the request may have reached the server; only matters for network errors. */
  sent: boolean;
  /** Error slug from the response body, when there was one. */
  slug: string | null;
  retryAfter: number | null;
  /** Retries already made; 0 after the first attempt. */
  retriesDone: number;
  /** Earlier 429 responses to this request, other than too_many_active_jobs; drives the 15/30/60 s schedule. */
  rateLimitsDone: number;
  /** Earlier too_many_active_jobs responses to this request; drives the 10-try budget. */
  activeJobsDone: number;
  maxRetries: number;
  random: () => number;
}

export type RetryPlan = { retry: true; delayMs: number } | { retry: false };

const STOP: RetryPlan = { retry: false };

function retriableFailure(retryClass: RetryClass, status: number | null, sent: boolean): boolean {
  switch (retryClass) {
    case "safe":
      return (
        status === null || status === 429 || status === 500 || (status >= 502 && status <= 504)
      );
    case "idempotent":
    case "upload-create":
      return status === null || status === 429 || status >= 500;
    case "purchase":
      return status === null || status === 502 || status === 503;
    case "mutate":
      return status === null && !sent;
    // Stryker disable next-line ConditionalExpression,StringLiteral: without this case the switch returns undefined, which reads as false too
    case "never":
      return false;
  }
}

/** Whether to retry a failed attempt and how long to wait first. */
export function planRetry(input: RetryInput): RetryPlan {
  const { retryClass, status, retryAfter, retriesDone, maxRetries } = input;
  if (!retriableFailure(retryClass, status, input.sent)) return STOP;
  if ((retryAfter ?? 0) > MAX_RETRY_AFTER_SECONDS) return STOP;

  let delayMs = backoffMs(retriesDone, input.random);
  let limit = retryClass === "purchase" ? Math.min(maxRetries, PURCHASE_MAX_RETRIES) : maxRetries;
  if (retryClass === "upload-create" && status === 429) {
    if (input.slug === "too_many_active_jobs") {
      if (maxRetries === 0 || input.activeJobsDone >= CREATE_ACTIVE_JOBS_RETRIES) return STOP;
      limit = Infinity;
      delayMs = CREATE_ACTIVE_JOBS_WAIT_MS;
    } else if (retryAfter === null) {
      if (input.rateLimitsDone >= CREATE_RATE_LIMIT_SCHEDULE_MS.length) return STOP;
      delayMs = CREATE_RATE_LIMIT_SCHEDULE_MS[input.rateLimitsDone] ?? delayMs;
    }
  }
  if (retriesDone >= limit) return STOP;
  return { retry: true, delayMs: retryAfter === null ? delayMs : retryAfter * 1000 };
}
