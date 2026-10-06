import fc from "fast-check";
import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import {
  AuthenticationError,
  NetworkError,
  OutcomeUnknownError,
  PermissionError,
  RateLimitError,
  ApiError,
} from "../src/errors";
import {
  backoffMs,
  parseRetryAfter,
  planRetry,
  retryClassFor,
  type RetryClass,
  type RetryInput,
} from "../src/http/retry";
import { call, config, fakeClock, networkError, stubFetch } from "./helpers";

function plan(over: Partial<RetryInput>): ReturnType<typeof planRetry> {
  return planRetry({
    retryClass: "safe",
    status: 503,
    sent: true,
    slug: null,
    retryAfter: null,
    retriesDone: 0,
    maxRetries: 3,
    random: () => 1,
    ...over,
  });
}

describe("backoff (spec 7.2)", () => {
  it("is full jitter under min(8 s, 0.5 s * 2^attempt)", () => {
    expect(backoffMs(0, () => 1)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(2, () => 1)).toBe(2000);
    expect(backoffMs(4, () => 1)).toBe(8000);
    expect(backoffMs(9, () => 1)).toBe(8000);
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBe(2000);
  });

  it("never leaves [0, ceiling]", () => {
    fc.assert(
      fc.property(fc.nat(40), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, r) => {
        const ms = backoffMs(attempt, () => r);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(Math.min(8000, 500 * 2 ** attempt));
      }),
    );
  });
});

describe("parseRetryAfter", () => {
  it("accepts integer seconds only", () => {
    expect(parseRetryAfter("61")).toBe(61);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 7 ")).toBe(7);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("1.5")).toBeNull();
    expect(parseRetryAfter("-3")).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("retry class by operation (spec 7.2)", () => {
  it.each<[string, string, RetryClass]>([
    ["GET", "/v1/account", "safe"],
    ["HEAD", "/v1/account", "safe"],
    ["GET", "/v1/uploads/{job}/part-urls", "safe"],
    ["POST", "/v1/uploads/{job}/heartbeat", "safe"],
    ["PUT", "/v1/uploads/{job}/parts/{n}", "safe"],
    ["POST", "/v1/uploads/{job}/complete", "safe"],
    ["POST", "/v1/uploads", "upload-create"],
    ["POST", "/v1/billing/purchase", "purchase"],
    ["POST", "/v1/billing/setup-session", "purchase"],
    ["POST", "/v1/agent/accounts/{signup_id}/claim", "never"],
    ["POST", "/v1/agent/credentials/rotate", "never"],
    ["POST", "/v1/agent/accounts", "never"],
    ["POST", "/v1/billing/cards/default", "mutate"],
    ["PATCH", "/v1/org/members/{user_id}", "mutate"],
    ["POST", "/v1/org/custody", "mutate"],
    ["POST", "/v1/org/transcripts/{id}/hold", "mutate"],
    ["DELETE", "/v1/org/transcripts/{id}/hold", "mutate"],
    ["post", "/v1/billing/purchase", "purchase"],
  ])("%s %s is %s", (method, path, expected) => {
    expect(retryClassFor(method, path)).toBe(expected);
  });

  it("classifies every operation of the committed spec, and only GETs are safe by default", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const cls = retryClassFor(method, path);
        if (cls === "safe") {
          expect(
            method === "get" || /heartbeat|parts\/\{n\}|complete/.test(path),
            `${method} ${path}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("planRetry", () => {
  it("retries a safe call on network errors, 429 and 5xx", () => {
    for (const status of [null, 429, 500, 502, 503, 504]) {
      expect(plan({ status }).retry, String(status)).toBe(true);
    }
  });

  it("does not retry other statuses", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect(plan({ status }).retry, String(status)).toBe(false);
    }
  });

  it("stops after maxRetries retries", () => {
    expect(plan({ retriesDone: 2 }).retry).toBe(true);
    expect(plan({ retriesDone: 3 }).retry).toBe(false);
    expect(plan({ maxRetries: 0 }).retry).toBe(false);
  });

  it("uses the jittered backoff for the attempt", () => {
    expect(plan({ retriesDone: 0 })).toEqual({ retry: true, delayMs: 500 });
    expect(plan({ retriesDone: 2 })).toEqual({ retry: true, delayMs: 2000 });
  });

  it("lets Retry-After override the backoff, up to 60 s", () => {
    expect(plan({ status: 429, retryAfter: 7 })).toEqual({ retry: true, delayMs: 7000 });
    expect(plan({ status: 429, retryAfter: 60 })).toEqual({ retry: true, delayMs: 60_000 });
    expect(plan({ status: 429, retryAfter: 0 })).toEqual({ retry: true, delayMs: 0 });
    expect(plan({ status: 429, retryAfter: 61 })).toEqual({ retry: false });
    expect(plan({ status: 503, retryAfter: 120 })).toEqual({ retry: false });
  });

  it("retries a purchase on network errors, 502 and 503 only, at most once", () => {
    for (const status of [null, 502, 503]) {
      expect(plan({ retryClass: "purchase", status }).retry, String(status)).toBe(true);
    }
    for (const status of [400, 402, 403, 429, 500, 504]) {
      expect(plan({ retryClass: "purchase", status }).retry, String(status)).toBe(false);
    }
    expect(plan({ retryClass: "purchase", retriesDone: 1, maxRetries: 3 }).retry).toBe(false);
    expect(plan({ retryClass: "purchase", maxRetries: 0 }).retry).toBe(false);
  });

  it("never retries claim, rotate and signup", () => {
    for (const status of [null, 429, 502, 503]) {
      expect(plan({ retryClass: "never", status }).retry).toBe(false);
    }
  });

  it("retries other mutations only when the request was not sent", () => {
    expect(plan({ retryClass: "mutate", status: null, sent: false }).retry).toBe(true);
    expect(plan({ retryClass: "mutate", status: null, sent: true }).retry).toBe(false);
    for (const status of [429, 500, 502, 503]) {
      expect(plan({ retryClass: "mutate", status }).retry).toBe(false);
    }
    expect(plan({ retryClass: "mutate", status: null, sent: false, retriesDone: 3 }).retry).toBe(
      false,
    );
  });

  it("paces upload creates: 429 without Retry-After backs off 15, 30, 60 s, then stops", () => {
    const create = (retriesDone: number): ReturnType<typeof planRetry> =>
      plan({ retryClass: "upload-create", status: 429, slug: "rate_limited", retriesDone });
    expect(create(0)).toEqual({ retry: true, delayMs: 15_000 });
    expect(create(1)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(2)).toEqual({ retry: true, delayMs: 60_000 });
    expect(create(3)).toEqual({ retry: false });
  });

  it("honors Retry-After on an upload create 429", () => {
    expect(
      plan({ retryClass: "upload-create", status: 429, slug: "rate_limited", retryAfter: 5 }),
    ).toEqual({ retry: true, delayMs: 5000 });
  });

  it("waits 30 s between tries on too_many_active_jobs, up to 10 tries", () => {
    const create = (retriesDone: number, maxRetries = 3): ReturnType<typeof planRetry> =>
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "too_many_active_jobs",
        retriesDone,
        maxRetries,
      });
    expect(create(0)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(8)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(9)).toEqual({ retry: false });
    expect(create(0, 0)).toEqual({ retry: false });
  });

  it("caps the 15/30/60 schedule by maxRetries", () => {
    expect(
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "rate_limited",
        retriesDone: 1,
        maxRetries: 1,
      }).retry,
    ).toBe(false);
  });

  it("uses the normal policy for the other upload create failures", () => {
    expect(plan({ retryClass: "upload-create", status: 503 })).toEqual({
      retry: true,
      delayMs: 500,
    });
    expect(plan({ retryClass: "upload-create", status: null })).toEqual({
      retry: true,
      delayMs: 500,
    });
    expect(plan({ retryClass: "upload-create", status: 402 }).retry).toBe(false);
  });
});

describe("through the hardened fetch", () => {
  it("does not wait for Retry-After above 60 s", async () => {
    const f = stubFetch([
      {
        status: 429,
        headers: { "retry-after": "61" },
        body: { error: "rate_limited", code: 5000 },
      },
    ]);
    await expect(call("safe")).rejects.toMatchObject({ code: "rate_limited", retryAfter: 61 });
    expect(f.calls).toBe(1);
    await expect(call("safe")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("waits Retry-After up to 60 s and retries", async () => {
    const clock = fakeClock();
    const f = stubFetch([
      {
        status: 429,
        headers: { "retry-after": "60" },
        body: { error: "rate_limited", code: 5000 },
      },
      { status: 200, body: { ok: true } },
    ]);
    const res = await call("safe", { cfg: config(clock) });
    expect(res.status).toBe(200);
    expect(f.calls).toBe(2);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("retries a safe call 3 times then raises the last response as an error", async () => {
    const clock = fakeClock();
    const f = stubFetch([{ status: 503, body: { error: "unavailable", code: 9000 } }]);
    await expect(call("safe", { cfg: config(clock) })).rejects.toBeInstanceOf(ApiError);
    expect(f.calls).toBe(4);
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it("honors maxRetries from the config", async () => {
    const f = stubFetch([{ status: 500, text: "boom" }]);
    await expect(
      call("safe", { cfg: config(fakeClock(), { maxRetries: 1 }) }),
    ).rejects.toMatchObject({
      status: 500,
    });
    expect(f.calls).toBe(2);
  });

  it("retries a purchase at most once and never on 4xx", async () => {
    const f = stubFetch([{ status: 502, text: "Bad Gateway" }]);
    await expect(call("purchase", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 502,
    });
    expect(f.calls).toBe(2);
    const g = stubFetch([
      { status: 403, body: { error: "pat_purchase_requires_app", code: 4021 } },
    ]);
    await expect(call("purchase", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(g.calls).toBe(1);
  });

  it("sends the same body and idempotency key on the purchase retry", async () => {
    const f = stubFetch([
      { status: 503, text: "x" },
      { status: 200, body: { balance_seconds: 1 } },
    ]);
    const body = JSON.stringify({ pack: "300min", idempotency_key: "k-1" });
    const res = await call("purchase", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(f.bodies).toEqual([body, body]);
    expect(f.requests.map((r) => r.headers.get("content-type"))).toEqual([
      "application/json",
      "application/json",
    ]);
  });

  it("retries a purchase after a network error once, then gives up", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    await expect(call("purchase", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(f.calls).toBe(2);
  });

  it("never retries claim", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    await expect(
      call("never", { method: "POST", path: "/v1/agent/accounts/sg_1/claim", body: "{}" }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toBe(1);
  });

  it("never retries an error response of the never class either", async () => {
    const f = stubFetch([{ status: 503, text: "x" }]);
    await expect(
      call("never", { method: "POST", path: "/v1/agent/credentials/rotate" }),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(f.calls).toBe(1);
  });

  it("does not retry a 401", async () => {
    const f = stubFetch([{ status: 401, body: { error: "unauthorized", code: 2000 } }]);
    await expect(call("safe")).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.calls).toBe(1);
  });
});
