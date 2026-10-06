import { vi } from "vitest";
import type { Clock } from "../src/clock";
import { resolveConfig, type ResolvedConfig } from "../src/config";
import { hardenedFetch } from "../src/http/fetch";
import type { RetryClass } from "../src/http/retry";

export const TOKEN =
  "hsr1:eu:pat.0123456789abcdef0123456789abcdef.fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
export const BASE = "http://127.0.0.1:4010";

export interface ManualClock extends Clock {
  /** Every sleep the code under test asked for, in ms. */
  sleeps: number[];
  /** Sleeps that are still waiting; resolved by `advance`. */
  pending: { at: number; wake: () => void }[];
  advance(ms: number): void;
}

/** Request timeout every test config uses; the auto clock never lets a sleep of this length finish. */
export const TEST_TIMEOUT_SECONDS = 4242;

/**
 * A clock whose sleeps resolve at once, advancing time and recording the request, unless `manual`
 * is set. A sleep of `holdMs` (the request timeout) is the exception: it waits, unrecorded, until
 * it is aborted, so ordinary requests do not time out the instant they start.
 */
export function fakeClock(options: { manual?: boolean; holdMs?: number } = {}): ManualClock {
  let now = 0;
  const holdMs = options.holdMs ?? TEST_TIMEOUT_SECONDS * 1000;
  const clock: ManualClock = {
    sleeps: [],
    pending: [],
    now: () => now,
    sleep(ms, signal) {
      const held = options.manual !== true && ms === holdMs;
      if (!held) clock.sleeps.push(ms);
      if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
      if (options.manual !== true && !held) {
        now += ms;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const entry = {
          at: now + ms,
          wake: () => {
            resolve();
          },
        };
        clock.pending.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            clock.pending.splice(clock.pending.indexOf(entry), 1);
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    },
    advance(ms) {
      now += ms;
      for (const entry of clock.pending.filter((e) => e.at <= now)) {
        clock.pending.splice(clock.pending.indexOf(entry), 1);
        entry.wake();
      }
    },
  };
  return clock;
}

export type Step =
  | { status: number; headers?: Record<string, string>; body?: unknown; text?: string }
  | { error: Error }
  | ((request: Request) => Response | Promise<Response>);

export interface StubFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: number;
  requests: Request[];
  bodies: string[];
}

/** Replays `steps` in order; the last step repeats. Installs itself as the global fetch. */
export function stubFetch(steps: Step[]): StubFetch {
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    stub.requests.push(request);
    stub.bodies.push(await request.text());
    const step = steps[Math.min(stub.calls, steps.length - 1)];
    stub.calls += 1;
    if (step === undefined) throw new Error("stubFetch needs at least one step");
    if (typeof step === "function") return step(request);
    if ("error" in step) throw step.error;
    const body = step.text ?? (step.body === undefined ? "" : JSON.stringify(step.body));
    return new Response(body, {
      status: step.status,
      headers: { "content-type": "application/json", ...step.headers },
    });
  }) as StubFetch;
  stub.calls = 0;
  stub.requests = [];
  stub.bodies = [];
  vi.stubGlobal("fetch", stub);
  return stub;
}

export function networkError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

export function config(
  clock: Clock = fakeClock(),
  extra: { maxRetries?: number; timeout?: number; logLevel?: "off" | "debug" } = {},
  lines: string[] = [],
): ResolvedConfig {
  return resolveConfig(
    { token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS, ...extra },
    { env: {}, random: () => 1, logSink: (line) => lines.push(line) },
  );
}

/** One call through the hardened fetch with a fresh config. */
export async function call(
  retryClass: RetryClass,
  options: {
    path?: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    cfg?: ResolvedConfig;
  } = {},
): Promise<Response> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) init.body = options.body;
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.signal !== undefined) init.signal = options.signal;
  return hardenedFetch(options.cfg ?? config(), retryClass)(
    `${BASE}${options.path ?? "/v1/account"}`,
    init,
  );
}

/** A fetch that never answers; it rejects when its signal aborts, even if that already happened. */
export function hang(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
