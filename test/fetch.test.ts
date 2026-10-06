import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbortError, NetworkError, OutcomeUnknownError } from "../src/errors";
import { hardenedFetch } from "../src/http/fetch";
import { BASE, TOKEN, call, config, fakeClock, hang, networkError, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("network errors and the sent flag", () => {
  it("raises OutcomeUnknownError with the claim hint when a claim was sent and no response came", async () => {
    stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await call("never", {
      method: "POST",
      path: "/v1/agent/accounts/sg_conf/claim",
      body: JSON.stringify({ claim_secret: "x" }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toContain("agent_claim_invalid");
    expect((error as OutcomeUnknownError).cause).toBeInstanceOf(Error);
  });

  it("gives the rotate hint for rotate", async () => {
    stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await call("never", {
      method: "POST",
      path: "/v1/agent/credentials/rotate",
    }).catch((e: unknown) => e);
    expect((error as OutcomeUnknownError).hint).toContain("old token may already be revoked");
  });

  it("raises NetworkError, not OutcomeUnknownError, when a never-class request never left", async () => {
    const f = stubFetch([{ error: networkError("ECONNREFUSED") }]);
    await expect(
      call("never", { method: "POST", path: "/v1/agent/accounts", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(f.calls).toBe(1);
  });

  it("retries a mutation that failed to connect, not one that was sent", async () => {
    const refused = stubFetch([{ error: networkError("ECONNREFUSED") }, { status: 200, body: {} }]);
    const res = await call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" });
    expect(res.status).toBe(200);
    expect(refused.calls).toBe(2);
    const reset = stubFetch([{ error: networkError("ECONNRESET") }, { status: 200, body: {} }]);
    await expect(
      call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(reset.calls).toBe(1);
  });

  it("treats a failure before the body was fully read as not sent", async () => {
    // The stub never reads the body stream, so the final pull never happened.
    const unread = vi.fn(() => Promise.reject(networkError("UND_ERR_SOCKET")));
    vi.stubGlobal("fetch", unread);
    await expect(
      call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    // retried: the request was judged unsent, so the mutate class tried again (1 + 3 retries).
    expect(unread).toHaveBeenCalledTimes(4);
  });

  it("treats a failure after the body was fully read as sent", async () => {
    const f = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        await new Request(input, init).arrayBuffer();
        throw networkError("UND_ERR_SOCKET");
      },
    );
    vi.stubGlobal("fetch", f);
    await expect(
      call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("wraps the final network error with the cause attached and redacted", async () => {
    stubFetch([{ error: new TypeError(`fetch failed for ${TOKEN}`) }]);
    const error = await call("safe", { cfg: config(fakeClock(), { maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).not.toContain(TOKEN);
    expect(((error as NetworkError).cause as Error).message).not.toContain(TOKEN);
  });
});

/* eslint-disable n/no-unsupported-features/node-builtins -- stable in every Node 22 release we test; the rule's table lags */
/** A 200 whose body delivers one chunk and then fails, or never ends. */
function brokenBody(mode: "error" | "stall"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"par'));
      if (mode === "error") controller.error(networkError("UND_ERR_SOCKET"));
    },
  });
  return new Response(stream, { status: 200 });
}

/* eslint-enable n/no-unsupported-features/node-builtins */

describe("failures while the body is still arriving", () => {
  it("raises OutcomeUnknownError when a claim loses its body after the headers", async () => {
    const f = stubFetch([() => brokenBody("error")]);
    const error = await call("never", {
      method: "POST",
      path: "/v1/agent/accounts/sg_conf/claim",
      body: "{}",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toBe(1);
  });

  it("retries a safe call whose body failed", async () => {
    const f = stubFetch([() => brokenBody("error"), { status: 200, body: { ok: true } }]);
    const res = await call("safe");
    expect(await res.json()).toEqual({ ok: true });
    expect(f.calls).toBe(2);
  });

  it("judges a body failure as sent even for a mutation", async () => {
    const f = stubFetch([() => brokenBody("error"), { status: 200, body: {} }]);
    await expect(
      call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(f.calls).toBe(1);
  });

  it("times out a body that never finishes", async () => {
    const clock = fakeClock({ manual: true });
    stubFetch([() => brokenBody("stall")]);
    const pending = call("safe", { cfg: config(clock, { timeout: 5, maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    await vi.waitFor(() => {
      expect(clock.pending.length).toBeGreaterThan(0);
    });
    clock.advance(5000);
    const error = await pending;
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toMatch(/timed out/i);
  });

  it("hands back a readable copy of a body that arrived whole", async () => {
    stubFetch([{ status: 201, headers: { "x-a": "1" }, body: { n: 1 } }]);
    const res = await call("safe");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.json()).toEqual({ n: 1 });
  });

  it("passes a bodiless status through", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const res = await call("safe");
    expect(res.status).toBe(204);
  });
});

describe("the part timeout (spec 3)", () => {
  it("lets a caller pick the timeout for one fetch", async () => {
    const clock = fakeClock({ manual: true });
    stubFetch([{ status: 200, body: {} }]);
    await hardenedFetch(config(clock), "safe", { timeoutMs: 300_000 })(`${BASE}/v1/x`);
    expect(clock.sleeps).toEqual([300_000]);
  });

  it("carries 300 s as the config's part timeout", () => {
    expect(config().partTimeoutMs).toBe(300_000);
  });
});

describe("timeouts and cancellation", () => {
  it("aborts a request that outlives the timeout and retries it", async () => {
    const clock = fakeClock({ manual: true });
    let seen = 0;
    const f = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen += 1;
      if (seen === 2) return Promise.resolve(new Response("{}", { status: 200 }));
      return hang(input, init);
    });
    vi.stubGlobal("fetch", f);
    const pending = call("safe", { cfg: config(clock, { timeout: 5 }) });
    await vi.waitFor(() => {
      expect(clock.pending.length).toBeGreaterThan(0);
    });
    expect(clock.sleeps[0]).toBe(5000);
    clock.advance(5000);
    await vi.waitFor(() => {
      expect(clock.sleeps.length).toBeGreaterThanOrEqual(2);
    });
    // backoff sleep, then the second attempt answers at once
    clock.advance(10_000);
    expect((await pending).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("reports NetworkError after the retries when every attempt times out", async () => {
    const clock = fakeClock();
    const f = vi.fn(hang);
    vi.stubGlobal("fetch", f);
    // fakeClock sleeps resolve at once, so the timeout timer fires immediately.
    const error = await call("safe", { cfg: config(clock, { maxRetries: 1, timeout: 7 }) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toMatch(/timed out/i);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("cancels the timeout timer when the response arrives", async () => {
    const clock = fakeClock({ manual: true });
    stubFetch([{ status: 200, body: {} }]);
    await call("safe", { cfg: config(clock) });
    expect(clock.pending).toHaveLength(0);
  });

  it("raises AbortError for a signal that is already aborted, without a request", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    const controller = new AbortController();
    controller.abort();
    await expect(call("safe", { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(f.calls).toBe(0);
  });

  it("raises AbortError when the signal fires during a request", async () => {
    const controller = new AbortController();
    const f = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      queueMicrotask(() => {
        controller.abort();
      });
      return hang(input, init);
    });
    vi.stubGlobal("fetch", f);
    await expect(
      call("safe", { signal: controller.signal, cfg: config(fakeClock({ manual: true })) }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("checks the signal during a backoff sleep", async () => {
    const clock = fakeClock({ manual: true });
    stubFetch([{ status: 503, text: "x" }]);
    const controller = new AbortController();
    const pending = call("safe", { signal: controller.signal, cfg: config(clock) }).catch(
      (e: unknown) => e,
    );
    await vi.waitFor(() => {
      expect(clock.sleeps.length).toBeGreaterThanOrEqual(2);
    });
    controller.abort();
    expect(await pending).toBeInstanceOf(AbortError);
  });
});

describe("logging (spec 10)", () => {
  it("writes nothing at the default level", async () => {
    const lines: string[] = [];
    stubFetch([{ status: 200, body: {} }]);
    await call("safe", { cfg: config(fakeClock(), {}, lines) });
    expect(lines).toEqual([]);
  });

  it("writes one line per attempt with method, path, status, attempt, duration and delay", async () => {
    const lines: string[] = [];
    stubFetch([
      { status: 503, text: "x" },
      { status: 200, body: {} },
    ]);
    await call("safe", {
      path: "/v1/jobs/job_1?secret=abc",
      cfg: config(fakeClock(), { logLevel: "debug" }, lines),
    });
    expect(lines).toEqual([
      "hushscript GET /v1/jobs/job_1 status=503 attempt=1 duration_ms=0 retry_in_ms=500",
      "hushscript GET /v1/jobs/job_1 status=200 attempt=2 duration_ms=0",
    ]);
  });

  it("logs network errors and never headers, bodies or query strings", async () => {
    const lines: string[] = [];
    stubFetch([{ error: networkError("ECONNRESET") }]);
    await call("never", {
      method: "POST",
      path: "/v1/agent/credentials/rotate?x=1",
      body: JSON.stringify({ title: "my secret title" }),
      cfg: config(fakeClock(), { logLevel: "debug" }, lines),
    }).catch(() => undefined);
    const text = lines.join("\n");
    expect(text).toContain("status=network_error");
    expect(text).not.toContain("secret title");
    expect(text).not.toContain("x=1");
    expect(text).not.toContain(TOKEN);
  });

  it("logs a direct-to-storage URL as r2:part/{n} without its signature", async () => {
    const lines: string[] = [];
    stubFetch([{ status: 200, body: {} }]);
    const cfg = config(fakeClock(), { logLevel: "debug" }, lines);
    await hardenedFetch(cfg, "safe")(
      "https://bucket.r2.example.com/uploads/job_1/parts/7?X-Amz-Signature=deadbeef",
      {
        method: "PUT",
        body: "x",
      },
    );
    expect(lines).toEqual(["hushscript PUT r2:part/7 status=200 attempt=1 duration_ms=0"]);
  });

  it("redacts a token that ends up in a log line", async () => {
    const lines: string[] = [];
    stubFetch([{ status: 200, body: {} }]);
    await call("safe", {
      path: `/v1/jobs/${TOKEN}`,
      cfg: config(fakeClock(), { logLevel: "debug" }, lines),
    });
    expect(lines.join()).not.toContain(TOKEN);
  });
});

describe("upload create pacing (spec 7.5)", () => {
  it("paces creates through a bucket of 4 per 60 s", async () => {
    const clock = fakeClock();
    const f = stubFetch([{ status: 200, body: { job_id: "j" } }]);
    const cfg = config(clock);
    for (let i = 0; i < 5; i += 1)
      await call("upload-create", { method: "POST", path: "/v1/uploads", body: "{}", cfg });
    expect(f.calls).toBe(5);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("backs off 15, 30, 60 s on rate_limited without Retry-After, then raises", async () => {
    const clock = fakeClock();
    const f = stubFetch([{ status: 429, body: { error: "rate_limited", code: 5000 } }]);
    await expect(
      call("upload-create", {
        method: "POST",
        path: "/v1/uploads",
        body: "{}",
        cfg: config(clock),
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(f.calls).toBe(4);
    expect(clock.sleeps).toEqual([15_000, 30_000, 60_000]);
  });

  it("waits 30 s on too_many_active_jobs and gives up after 10 tries", async () => {
    const clock = fakeClock();
    const f = stubFetch([{ status: 429, body: { error: "too_many_active_jobs", code: 5001 } }]);
    await expect(
      call("upload-create", {
        method: "POST",
        path: "/v1/uploads",
        body: "{}",
        cfg: config(clock),
      }),
    ).rejects.toMatchObject({
      code: "too_many_active_jobs",
    });
    expect(f.calls).toBe(10);
    expect(clock.sleeps.filter((ms) => ms === 30_000)).toHaveLength(9);
  });

  it("reuses the body and key on every retry of a create", async () => {
    const f = stubFetch([
      { status: 429, body: { error: "rate_limited", code: 5000 } },
      { status: 200, body: {} },
    ]);
    const body = JSON.stringify({ idempotency_key: "0123456789abcdef0123" });
    await call("upload-create", { method: "POST", path: "/v1/uploads", body });
    expect(f.bodies).toEqual([body, body]);
  });
});

describe("request shaping", () => {
  it("does not add an Authorization header of its own (part PUTs to storage must not carry one)", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    await call("safe");
    expect(f.requests[0]?.headers.get("authorization")).toBeNull();
  });

  it("keeps the caller's headers and method", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    await call("safe", {
      method: "PUT",
      body: "abc",
      headers: { "x-a": "1", authorization: "Bearer t" },
    });
    expect(f.requests[0]?.method).toBe("PUT");
    expect(f.requests[0]?.headers.get("x-a")).toBe("1");
    expect(f.requests[0]?.headers.get("authorization")).toBe("Bearer t");
  });

  it("returns a successful response untouched, body readable", async () => {
    stubFetch([{ status: 201, body: { a: 1 } }]);
    const res = await call("safe");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("accepts a Request object as input", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    await hardenedFetch(
      config(),
      "safe",
    )(new Request(`${BASE}/v1/account`, { headers: { "x-b": "2" } }));
    expect(f.requests[0]?.headers.get("x-b")).toBe("2");
  });
});

describe("against a real HTTP server", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server?.closeAllConnections();
  });

  async function listen(
    handler: (request: IncomingMessage, count: number) => { status: number; body?: string },
  ): Promise<{
    url: string;
    seen: { length: string | undefined; chunked: string | undefined; body: string }[];
  }> {
    const seen: { length: string | undefined; chunked: string | undefined; body: string }[] = [];
    const created = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          length: request.headers["content-length"],
          chunked: request.headers["transfer-encoding"],
          body: Buffer.concat(chunks).toString(),
        });
        const reply = handler(request, seen.length);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body ?? "{}");
      });
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${String((created.address() as AddressInfo).port)}`, seen };
  }

  it("replays the body with an exact Content-Length on a retry", async () => {
    vi.unstubAllGlobals();
    const { url, seen } = await listen((_request, count) => ({ status: count === 1 ? 503 : 200 }));
    const body = JSON.stringify({ pack: "300min", note: "héllo" });
    const cfg = config(fakeClock());
    const res = await hardenedFetch(cfg, "safe")(`${url}/v1/x`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.body)).toEqual([body, body]);
    expect(seen.map((s) => s.length)).toEqual([
      String(Buffer.byteLength(body)),
      String(Buffer.byteLength(body)),
    ]);
    expect(seen.every((s) => s.chunked === undefined)).toBe(true);
  });

  it("sends a body larger than one chunk intact", async () => {
    vi.unstubAllGlobals();
    const { url, seen } = await listen(() => ({ status: 200 }));
    const body = "x".repeat(700_000);
    await hardenedFetch(config(), "safe")(`${url}/v1/x`, { method: "PUT", body });
    expect(seen[0]?.body.length).toBe(700_000);
    expect(seen[0]?.length).toBe("700000");
  });

  it("reports a refused connection as NetworkError after the retries", async () => {
    vi.unstubAllGlobals();
    const { url } = await listen(() => ({ status: 200 }));
    server?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      hardenedFetch(config(fakeClock(), { maxRetries: 1 }), "safe")(`${url}/v1/x`),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
