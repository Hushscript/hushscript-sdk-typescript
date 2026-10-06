export type RetryClass = "safe" | "upload-create" | "purchase" | "never" | "mutate";

/** A Retry-After above this is never waited for (spec 7.2). */
const MAX_RETRY_AFTER_SECONDS = 60;

const BACKOFF_CAP_MS = 8000;
const BACKOFF_BASE_MS = 500;
const PURCHASE_MAX_RETRIES = 1;
/** Spec 7.5: rate_limited without Retry-After on an upload create backs off 15, 30, 60 s, then raises. */
const CREATE_RATE_LIMIT_SCHEDULE_MS: readonly number[] = [15_000, 30_000, 60_000];
/** Spec 7.5: too_many_active_jobs waits 30 s between tries, up to 10 tries. */
const CREATE_ACTIVE_JOBS_WAIT_MS = 30_000;
const CREATE_ACTIVE_JOBS_RETRIES = 9;

/**
 * Spec 7.2, by `METHOD /path/template`. Everything that is neither listed here nor a GET or HEAD
 * mutates and is only retried when the request provably never left (`mutate`).
 */
export const EXPLICIT_CLASSES: Readonly<Record<string, RetryClass>> = {
  "POST /v1/uploads": "upload-create",
  "PUT /v1/uploads/{job}/parts/{n}": "safe",
  "POST /v1/uploads/{job}/heartbeat": "safe",
  "POST /v1/uploads/{job}/complete": "safe",
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

/** Integer seconds only; HTTP dates and anything else count as absent. */
export function parseRetryAfter(header: string | null): number | null {
  const text = header?.trim() ?? "";
  return /^\d+$/.test(text) ? Number(text) : null;
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
  maxRetries: number;
  random: () => number;
}

export type RetryPlan = { retry: true; delayMs: number } | { retry: false };

const STOP: RetryPlan = { retry: false };

function retriableFailure(retryClass: RetryClass, status: number | null, sent: boolean): boolean {
  switch (retryClass) {
    case "safe":
    case "upload-create":
      return status === null || status === 429 || status >= 500;
    case "purchase":
      return status === null || status === 502 || status === 503;
    case "mutate":
      return status === null && !sent;
    case "never":
      return false;
  }
}

/** Whether to retry a failed attempt and how long to wait first. */
export function planRetry(input: RetryInput): RetryPlan {
  const { retryClass, status, retryAfter, retriesDone, maxRetries } = input;
  if (!retriableFailure(retryClass, status, input.sent)) return STOP;
  if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_SECONDS) return STOP;

  let limit = retryClass === "purchase" ? Math.min(maxRetries, PURCHASE_MAX_RETRIES) : maxRetries;
  let delayMs = backoffMs(retriesDone, input.random);
  if (retryClass === "upload-create" && status === 429) {
    if (input.slug === "too_many_active_jobs") {
      limit = maxRetries === 0 ? 0 : CREATE_ACTIVE_JOBS_RETRIES;
      delayMs = CREATE_ACTIVE_JOBS_WAIT_MS;
    } else if (retryAfter === null) {
      limit = Math.min(maxRetries, CREATE_RATE_LIMIT_SCHEDULE_MS.length);
      delayMs =
        CREATE_RATE_LIMIT_SCHEDULE_MS[
          Math.min(retriesDone, CREATE_RATE_LIMIT_SCHEDULE_MS.length - 1)
        ] ?? delayMs;
    }
  }
  if (retriesDone >= limit) return STOP;
  return { retry: true, delayMs: retryAfter === null ? delayMs : retryAfter * 1000 };
}
