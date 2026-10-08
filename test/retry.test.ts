import fc from "fast-check";
import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import {
  AuthenticationError,
  NetworkError,
  OutcomeUnknownError,
  PermissionDeniedError,
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
    rateLimitsDone: 0,
    activeJobsDone: 0,
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
    ["PUT", "/v1/uploads/{job}/parts/{n}", "idempotent"],
    ["POST", "/v1/uploads/{job}/complete", "idempotent"],
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

  it("classifies every operation of the committed spec by the spec 7.2 policy", () => {
    const exceptional: Record<string, RetryClass> = {
      "POST /v1/uploads": "upload-create",
      "PUT /v1/uploads/{job}/parts/{n}": "idempotent",
      "POST /v1/uploads/{job}/complete": "idempotent",
      "POST /v1/uploads/{job}/heartbeat": "safe",
      "POST /v1/billing/purchase": "purchase",
      "POST /v1/billing/setup-session": "purchase",
      "POST /v1/agent/accounts": "never",
      "POST /v1/agent/accounts/{signup_id}/claim": "never",
      "POST /v1/agent/credentials/rotate": "never",
    };
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) =>
          ["get", "head", "post", "put", "patch", "delete", "options", "trace"].includes(method),
        )
        .map((method) => ({ method, path })),
    );
    expect(operations.length).toBeGreaterThan(0);
    const visited = new Set<string>();
    for (const { method, path } of operations) {
      const operation = `${method.toUpperCase()} ${path}`;
      const expected =
        exceptional[operation] ?? (method === "get" || method === "head" ? "safe" : "mutate");
      expect(retryClassFor(method, path), operation).toBe(expected);
      visited.add(operation);
    }
    for (const operation of Object.keys(exceptional))
      expect(visited.has(operation), operation).toBe(true);
  });
});

describe("planRetry", () => {
  it("retries a safe call on network errors, 429, 500, 502, 503 and 504 only", () => {
    for (const status of [null, 429, 500, 502, 503, 504]) {
      expect(plan({ status }).retry, String(status)).toBe(true);
    }
    for (const status of [501, 505, 507]) {
      expect(plan({ status }).retry, String(status)).toBe(false);
    }
  });

  it("retries an idempotent call (part PUT, complete) on any 5xx", () => {
    for (const status of [null, 429, 500, 501, 502, 503, 504, 505]) {
      expect(plan({ retryClass: "idempotent", status }).retry, String(status)).toBe(true);
    }
    expect(plan({ retryClass: "idempotent", status: 404 }).retry).toBe(false);
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
    expect(plan({ status: 429, retryAfter: Number.MAX_SAFE_INTEGER })).toEqual({ retry: false });
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
    const create = (rateLimitsDone: number, retriesDone = rateLimitsDone, maxRetries = 10) =>
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "rate_limited",
        rateLimitsDone,
        retriesDone,
        maxRetries,
      });
    expect(create(0)).toEqual({ retry: true, delayMs: 15_000 });
    expect(create(1)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(2)).toEqual({ retry: true, delayMs: 60_000 });
    expect(create(3)).toEqual({ retry: false });
  });

  it("counts only its own 429s for the 15/30/60 schedule (M4)", () => {
    // Two network retries came first; the first 429 still waits 15 s, the second 30 s.
    const create = (rateLimitsDone: number, retriesDone: number) =>
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "rate_limited",
        rateLimitsDone,
        retriesDone,
        maxRetries: 10,
      });
    expect(create(0, 2)).toEqual({ retry: true, delayMs: 15_000 });
    expect(create(1, 3)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(3, 5)).toEqual({ retry: false });
    // maxRetries still caps every kind of retry together.
    expect(
      plan({ retryClass: "upload-create", status: 429, slug: "rate_limited", retriesDone: 3 })
        .retry,
    ).toBe(false);
  });

  it("honors Retry-After on an upload create 429", () => {
    expect(
      plan({ retryClass: "upload-create", status: 429, slug: "rate_limited", retryAfter: 5 }),
    ).toEqual({ retry: true, delayMs: 5000 });
  });

  it("waits 30 s between tries on too_many_active_jobs, up to 10 tries", () => {
    const create = (
      activeJobsDone: number,
      maxRetries = 3,
      retriesDone = 0,
    ): ReturnType<typeof planRetry> =>
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "too_many_active_jobs",
        activeJobsDone,
        retriesDone,
        maxRetries,
      });
    expect(create(0)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(8)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(9)).toEqual({ retry: false });
    expect(create(0, 0)).toEqual({ retry: false });
  });

  it("counts only too_many_active_jobs responses for the 10-try budget (M4)", () => {
    const create = (activeJobsDone: number, retriesDone: number): ReturnType<typeof planRetry> =>
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "too_many_active_jobs",
        activeJobsDone,
        retriesDone,
      });
    // Earlier network retries and other 429s do not shorten the budget or pass maxRetries.
    expect(create(0, 5)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(8, 12)).toEqual({ retry: true, delayMs: 30_000 });
    expect(create(9, 12)).toEqual({ retry: false });
  });

  it("caps the 15/30/60 schedule by maxRetries", () => {
    expect(
      plan({
        retryClass: "upload-create",
        status: 429,
        slug: "rate_limited",
        retriesDone: 1,
        rateLimitsDone: 1,
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

  it.each(["9".repeat(400), "9007199254740993", "99999999999999999999"])(
    "does not retry a Retry-After of %s and reports it capped",
    async (header) => {
      const f = stubFetch([
        {
          status: 429,
          headers: { "retry-after": header },
          body: { error: "rate_limited", code: 5000 },
        },
      ]);
      await expect(call("safe")).rejects.toMatchObject({
        code: "rate_limited",
        retryAfter: Number.MAX_SAFE_INTEGER,
      });
      expect(f.calls).toBe(1);
    },
  );

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
      PermissionDeniedError,
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

  it("raises the status's own class, with retryAfter, for a Retry-After above 60 s on a non-429", async () => {
    const f = stubFetch([{ status: 503, headers: { "retry-after": "120" }, text: "busy" }]);
    const error = await call("safe").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 503, retryAfter: 120 });
    expect(f.calls).toBe(1);
  });

  it("does not retry a 501 on a safe call but does on an idempotent one", async () => {
    const safe = stubFetch([{ status: 501, text: "x" }]);
    await expect(call("safe")).rejects.toMatchObject({ status: 501 });
    expect(safe.calls).toBe(1);
    const idempotent = stubFetch([{ status: 501, text: "x" }]);
    await expect(
      call("idempotent", { method: "PUT", path: "/v1/uploads/j/parts/1", body: "x" }),
    ).rejects.toMatchObject({ status: 501 });
    expect(idempotent.calls).toBe(4);
  });

  it("starts the create schedule at 15 s even after a network retry (M4)", async () => {
    const clock = fakeClock();
    const f = stubFetch([
      { error: networkError("ECONNRESET") },
      { status: 429, body: { error: "rate_limited", code: 5000 } },
    ]);
    await expect(
      call("upload-create", {
        method: "POST",
        path: "/v1/uploads",
        body: "{}",
        cfg: config(clock, { maxRetries: 10 }),
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(clock.sleeps).toEqual([500, 15_000, 30_000, 60_000]);
    expect(f.calls).toBe(5);
  });

  it("keeps the 10-try too_many_active_jobs budget after a network retry (M4)", async () => {
    const clock = fakeClock();
    const f = stubFetch([
      { error: networkError("ECONNRESET") },
      { status: 429, body: { error: "too_many_active_jobs", code: 5001 } },
    ]);
    await expect(
      call("upload-create", {
        method: "POST",
        path: "/v1/uploads",
        body: "{}",
        cfg: config(clock),
      }),
    ).rejects.toMatchObject({ code: "too_many_active_jobs" });
    expect(f.calls).toBe(11);
    expect(clock.sleeps.filter((ms) => ms === 30_000)).toHaveLength(9);
  });
});
