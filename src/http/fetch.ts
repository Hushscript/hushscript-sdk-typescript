import type { ResolvedConfig } from "../config.ts";
import {
  AbortError,
  HushscriptError,
  NetworkError,
  OutcomeUnknownError,
  asHushscriptError,
  errorFromResponse,
} from "../errors.ts";
import { describeTarget } from "../log.ts";
import { operationFor } from "./operations.ts";
import { parseRetryAfter, planRetry, type RetryClass } from "./retry.ts";

const BODY_CHUNK_BYTES = 256 * 1024;
// Failures of connection setup (DNS, connect, TLS certificate checks): they come before the first
// byte of the request is written, so they mean "not sent" whatever the body stream did. Every other
// code (EHOSTUNREACH, ENETUNREACH, ERR_SSL_* and the rest) can also surface on a connection that is
// already carrying the request, so it does not.
const NEVER_SENT =
  /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_CERT_ALTNAME_INVALID|CERT_|DEPTH_ZERO_|UNABLE_TO_|SELF_SIGNED_)/;

interface Failure {
  error: unknown;
  sent: boolean;
  timedOut: boolean;
}

type Outcome = { kind: "response"; response: Response } | { kind: "failure"; failure: Failure };

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * The body as a stream that records when its last chunk was handed over. A network error before
 * that point means the server cannot have received a complete request. The queue holds nothing
 * (highWaterMark 0), so a chunk is produced only when the transport asks for it.
 */
/* eslint-disable n/no-unsupported-features/node-builtins -- stable in every Node 22 release we test; the rule's table lags */
function bodyStream(bytes: Uint8Array, progress: { done: boolean }): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        const end = Math.min(offset + BODY_CHUNK_BYTES, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        if (offset >= bytes.byteLength) {
          progress.done = true;
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/* eslint-enable n/no-unsupported-features/node-builtins */

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** Never resolves; rejects with the signal's reason once it aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
  });
}

// Real error bodies are a few levels deep. A deeper one is hostile or broken, and the recursive
// walks that build an error from it (camelCasing, redaction) would overflow the stack.
const MAX_BODY_DEPTH = 64;

function nestsDeeperThan(root: unknown, limit: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (typeof value !== "object" || value === null) continue;
    if (depth >= limit) return true;
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return false;
}

/** The parsed JSON, or the raw text when it does not parse or nests too deeply to be an error body. */
function parseBody(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown;
    return nestsDeeperThan(parsed, MAX_BODY_DEPTH) ? text : parsed;
  } catch {
    return text;
  }
}

function slugOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const slug = (body as { error?: unknown }).error;
  return typeof slug === "string" ? slug : null;
}

// A function call, so the compiler does not carry an earlier `signal.aborted` check into the loop.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function aborted(signal: AbortSignal): AbortError {
  return new AbortError({ message: "The request was aborted.", cause: signal.reason });
}

async function pause(cfg: ResolvedConfig, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await cfg.clock.sleep(ms, signal);
  } catch (error) {
    if (signal.aborted) throw aborted(signal);
    throw error;
  }
}

async function attempt(
  timeoutMs: number,
  cfg: ResolvedConfig,
  request: {
    url: string;
    method: string;
    headers: Headers;
    bytes: Uint8Array | null;
  },
  callerSignal: AbortSignal,
): Promise<Outcome> {
  const controller = new AbortController();
  const stopTimer = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(callerSignal.reason);
  };
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  // The timeout runs on the injected clock, so a virtual clock can fire it.
  cfg.clock.sleep(timeoutMs, stopTimer.signal).then(
    () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    },
    () => undefined,
  );
  const progress = { done: request.bytes === null };
  let headersArrived = false;
  try {
    const response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.bytes === null ? null : bodyStream(request.bytes, progress),
      duplex: "half",
      // Never followed: a 3xx is an error, and credentials never leave the API origin.
      redirect: "manual",
      signal: controller.signal,
    });
    headersArrived = true;
    // The body is read here, while the timeout and the abort are still armed: a body that stalls
    // or breaks is a failed attempt, not something the caller finds out about later.
    const bytes = NULL_BODY_STATUSES.has(response.status)
      ? null
      : await Promise.race([response.arrayBuffer(), whenAborted(controller.signal)]);
    return {
      kind: "response",
      response: new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  } catch (error) {
    // Once the body is fully written the request is sent, whatever the error code says.
    const connectPhase = NEVER_SENT.test(errorCode(error) ?? "");
    const sent = headersArrived || (!connectPhase && progress.done);
    return { kind: "failure", failure: { error, sent, timedOut } };
  } finally {
    stopTimer.abort();
    callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

function terminalFailure(
  timeoutMs: number,
  retryClass: RetryClass,
  operation: string,
  failure: Failure,
  callerSignal: AbortSignal,
): HushscriptError {
  const code = errorCode(failure.error);
  const callerAborted = isAborted(callerSignal);
  const reason = callerAborted
    ? "The request was aborted."
    : failure.timedOut
      ? `The request timed out after ${String(timeoutMs / 1000)} s.`
      : `The request failed before a response arrived${code === undefined ? "" : ` (${code})`}.`;
  if (retryClass === "never" && failure.sent) {
    return new OutcomeUnknownError({
      message: `${reason} The request was sent, so its outcome is unknown.`,
      hint: OutcomeUnknownError.hintFor(operation),
      cause: callerAborted ? aborted(callerSignal) : failure.error,
    });
  }
  if (callerAborted) return aborted(callerSignal);
  return new NetworkError({ message: reason, cause: failure.error });
}

/**
 * `fetch` with the SDK's hardening: per-request timeout, retries by class, pacing of
 * upload creates, typed errors for non-2xx answers, redacted debug lines. It adds no
 * credentials: direct-to-storage part PUTs must not carry an Authorization header.
 */
export function hardenedFetch(
  cfg: ResolvedConfig,
  retryClass: RetryClass,
  options: { timeoutMs?: number } = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const guarded: typeof fetch = async (input, init) => {
    // Bytes are used where they are: building a Request from them would copy every part.
    const direct = init?.body instanceof Uint8Array ? init.body : null;
    const request = new Request(input, direct === null ? init : { ...init, body: null });
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const operation = operationFor(method, url.pathname);
    const apiOrigin = new URL(cfg.baseUrl).origin;
    const target = describeTarget(url, apiOrigin);
    const signal = request.signal;
    const buffer =
      direct ?? (request.body === null ? null : new Uint8Array(await request.arrayBuffer()));
    const bytes = buffer !== null && buffer.byteLength > 0 ? buffer : null;
    const headers = new Headers(request.headers);
    if (url.origin !== apiOrigin) headers.delete("authorization");
    // Read again for every attempt: a token rotated while this request waits (a retry's backoff or
    // the create pacer) must be the one it goes out with.
    const carriesToken = headers.has("authorization");
    if (bytes !== null) headers.set("content-length", String(bytes.byteLength));
    const prepared = { url: request.url, method, headers, bytes };

    let rateLimitsDone = 0;
    let activeJobsDone = 0;
    for (let retriesDone = 0; ; retriesDone += 1) {
      if (signal.aborted) throw aborted(signal);
      if (operation === "POST /v1/uploads")
        await cfg.createPacer.acquire(signal).catch(() => {
          throw aborted(signal);
        });
      if (carriesToken) prepared.headers.set("authorization", cfg.authorization());
      const startedAt = cfg.clock.now();
      const outcome = await attempt(timeoutMs, cfg, prepared, signal);
      const durationMs = cfg.clock.now() - startedAt;
      const log = (status: number | string, retryDelayMs: number | null): void => {
        cfg.logger.attempt({
          method,
          target,
          status,
          attempt: retriesDone + 1,
          durationMs,
          retryDelayMs,
        });
      };

      if (outcome.kind === "response") {
        const response = outcome.response;
        if (response.ok) {
          log(response.status, null);
          return response;
        }
        const body = parseBody(await response.text().catch(() => ""));
        const plan = planRetry({
          retryClass,
          status: response.status,
          sent: true,
          slug: slugOf(body),
          retryAfter: parseRetryAfter(response.headers.get("retry-after")),
          retriesDone,
          rateLimitsDone,
          activeJobsDone,
          maxRetries: cfg.maxRetries,
          random: cfg.random,
        });
        if (response.status === 429) {
          if (slugOf(body) === "too_many_active_jobs") activeJobsDone += 1;
          else rateLimitsDone += 1;
        }
        log(response.status, plan.retry ? plan.delayMs : null);
        if (!plan.retry) throw errorFromResponse(response, body, operation);
        await pause(cfg, plan.delayMs, signal);
        continue;
      }

      const failure = outcome.failure;
      if (isAborted(signal))
        throw terminalFailure(timeoutMs, retryClass, operation, failure, signal);
      const plan = planRetry({
        retryClass,
        status: null,
        sent: failure.sent,
        slug: null,
        retryAfter: null,
        retriesDone,
        rateLimitsDone,
        activeJobsDone,
        maxRetries: cfg.maxRetries,
        random: cfg.random,
      });
      log(failure.timedOut ? "timeout" : "network_error", plan.retry ? plan.delayMs : null);
      if (!plan.retry) throw terminalFailure(timeoutMs, retryClass, operation, failure, signal);
      await pause(cfg, plan.delayMs, signal);
    }
  };
  // Whatever fails in here after a request went out surfaces as an SDK error; for a call the server
  // cannot repeat it is an unknown outcome, not a plain failure.
  return async (input, init) => {
    try {
      return await guarded(input, init);
    } catch (error) {
      if (error instanceof HushscriptError) throw error;
      if (retryClass === "never") {
        throw new OutcomeUnknownError({
          message:
            "The SDK failed unexpectedly after the request was sent, so its outcome is unknown.",
          cause: error,
        });
      }
      throw asHushscriptError(error);
    }
  };
}
