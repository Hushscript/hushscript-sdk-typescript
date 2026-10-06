import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import {
  NetworkError,
  OutcomeUnknownError,
  PermissionDeniedError,
  RateLimitError,
} from "../src/errors";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, networkError, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(clock = fakeClock()): Hushscript {
  return new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
}

describe("hs.api", () => {
  it("sends the bearer token and the user agent to the configured base URL", async () => {
    const f = stubFetch([{ status: 200, body: { balance_seconds: 120 } }]);
    const { data } = await client().api.GET("/v1/account");
    expect(data).toEqual({ balance_seconds: 120 });
    const request = f.requests[0];
    expect(request?.url).toBe(`${BASE}/v1/account`);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get("user-agent")).toMatch(
      /^hushscript-typescript\/\d+\.\d+\.\d+ (node|bun|deno)\//,
    );
  });

  it("throws the SDK's typed errors instead of returning an error object", async () => {
    stubFetch([{ status: 403, body: { error: "pat_scope_missing", code: 2023 } }]);
    const error = await client()
      .api.GET("/v1/transcripts")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).hint).toContain('"transcripts:read" permission');
  });

  it("does not wait for Retry-After above 60 s", async () => {
    const clock = fakeClock();
    const f = stubFetch([
      {
        status: 429,
        headers: { "retry-after": "61" },
        body: { error: "rate_limited", code: 5000 },
      },
    ]);
    await expect(client(clock).api.GET("/v1/account")).rejects.toBeInstanceOf(RateLimitError);
    expect(f.calls).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it("retries GETs like a safe operation", async () => {
    const f = stubFetch([
      { status: 503, text: "x" },
      { status: 200, body: { jobs: [] } },
    ]);
    const { response } = await client().api.GET("/v1/jobs");
    expect(response.status).toBe(200);
    expect(f.calls).toBe(2);
  });

  it("retries a purchase at most once", async () => {
    const f = stubFetch([{ status: 502, text: "Bad Gateway" }]);
    await expect(
      client().api.POST("/v1/billing/purchase", {
        body: { pack: "300min", idempotency_key: "k-1", quick_payment_method_id: "pm_1" },
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(f.calls).toBe(2);
    expect(f.bodies[0]).toBe(f.bodies[1]);
  });

  it("never retries claim: a lost response is an unknown outcome", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    await expect(
      client().api.POST("/v1/agent/accounts/{signup_id}/claim", {
        // The spec leaves this path parameter undeclared, so the generated type forbids it.
        params: { path: { signup_id: "sg_conformance" } } as never,
        body: { claim_secret: "cs" },
      }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toBe(1);
  });

  it("does not retry rotate on a 503", async () => {
    const f = stubFetch([{ status: 503, text: "x" }]);
    await expect(client().api.POST("/v1/agent/credentials/rotate")).rejects.toMatchObject({
      status: 503,
    });
    expect(f.calls).toBe(1);
  });

  it("retries a mutation only when it never left", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    await expect(
      client().api.POST("/v1/org/custody", { body: { transcript_ids: [] } as never }),
    ).rejects.toThrow();
    expect(f.calls).toBe(1);
  });

  it("paces creates through the client's bucket", async () => {
    const clock = fakeClock();
    const f = stubFetch([{ status: 200, body: { job_id: "j" } }]);
    const hs = client(clock);
    for (let i = 0; i < 5; i += 1) {
      await hs.api.POST("/v1/uploads", {
        body: { size_bytes: 1, duration_seconds: 20, idempotency_key: "0123456789abcdef0123" },
      });
    }
    expect(f.calls).toBe(5);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("keeps the caller's abort signal", async () => {
    stubFetch([{ status: 200, body: {} }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client().api.GET("/v1/account", { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("classifies a GET by its URL and retries it", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    await expect(client().api.request("get", "/v1/account")).rejects.toThrow();
    expect(f.calls).toBe(4);
  });

  it("classifies by the concrete URL: a claim path spelled out is still never retried", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await client()
      // The generated type forbids the template's path parameter, so callers cast; a concrete path is the natural cast.
      .api.POST("/v1/agent/accounts/sg_1/claim" as never, { body: { claim_secret: "cs" } } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toContain("agent_claim_invalid");
    expect(f.calls).toBe(1);
  });

  it("keeps the class when a middleware swaps the request for a new one", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    const hs = client();
    hs.api.use({
      onRequest: ({ request }) =>
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify({ claim_secret: "cs" }),
        }),
    });
    await expect(
      hs.api.POST("/v1/agent/accounts/{signup_id}/claim", {
        params: { path: { signup_id: "sg_1" } } as never,
        body: { claim_secret: "cs" },
      }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toBe(1);
  });

  it("does not replay an unlisted POST that was sent", async () => {
    const f = stubFetch([{ error: networkError("EHOSTUNREACH") }]);
    await expect(
      client().api.POST("/v1/org/custody", { body: { transcript_ids: [] } as never }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(f.calls).toBe(1);
  });

  it("does not replay a lost agent signup and gives it no hint", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await client()
      .api.POST("/v1/agent/accounts", { body: {} as never })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toBeNull();
    expect(f.calls).toBe(1);
  });
});

describe("the client object", () => {
  it("exposes api and nothing that holds the token", () => {
    const hs = client();
    expect(Object.keys(hs)).toEqual(["api", "jobs"]);
    expect(JSON.stringify(hs)).not.toContain(TOKEN.slice(12));
  });
});
