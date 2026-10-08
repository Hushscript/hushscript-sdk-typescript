import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortError,
  ApiError,
  HushscriptError,
  NetworkError,
  OutcomeUnknownError,
} from "../src/errors";
import type { Clock } from "../src/clock";
import type { ResolvedConfig } from "../src/config";
import { hardenedFetch } from "../src/http/fetch";
import { Hushscript } from "../src/client";
import { driven, fakeApi } from "./transcribe/fakeapi";
import {
  BASE,
  TEST_TIMEOUT_SECONDS,
  TOKEN,
  call,
  config,
  fakeClock,
  hang,
  networkError,
  stubFetch,
  type StubFetch,
} from "./helpers";

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
    expect(error).toMatchObject({ code: "outcome_unknown", status: null });
    expect((error as OutcomeUnknownError).hint).toBe(
      "The claim may have succeeded. Retrying will fail with agent_claim_invalid. If you have no token, contact support with the signup id.",
    );
    expect((error as OutcomeUnknownError).cause).toBeInstanceOf(Error);
  });

  it("gives the rotate hint for rotate", async () => {
    stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await call("never", {
      method: "POST",
      path: "/v1/agent/credentials/rotate",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "outcome_unknown", status: null });
    expect((error as OutcomeUnknownError).hint).toBe(
      "The old token may already be revoked. Try a request with it; if it fails, the new token was lost and the account needs support.",
    );
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

  /** A fetch that reads the whole request body, then fails with `error`. */
  function failAfterBody(error: Error): ReturnType<typeof vi.fn> {
    const f = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        await new Request(input, init).arrayBuffer();
        throw error;
      },
    );
    vi.stubGlobal("fetch", f);
    return f;
  }

  it.each(["EHOSTUNREACH", "ENETUNREACH", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"])(
    "treats %s after the body was written as sent: no mutation replay, claim outcome unknown",
    async (code) => {
      const mutate = failAfterBody(networkError(code));
      await expect(
        call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
      ).rejects.toBeInstanceOf(NetworkError);
      expect(mutate).toHaveBeenCalledTimes(1);
      const claim = failAfterBody(networkError(code));
      await expect(
        call("never", {
          method: "POST",
          path: "/v1/agent/accounts/sg_1/claim",
          body: JSON.stringify({ claim_secret: "x" }),
        }),
      ).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(claim).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["EHOSTUNREACH", "ENETUNREACH", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"])(
    "keeps the rotate hint when a bodyless rotate fails with %s",
    async (code) => {
      stubFetch([{ error: networkError(code) }]);
      const error = await call("never", {
        method: "POST",
        path: "/v1/agent/credentials/rotate",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect(error).toMatchObject({ code: "outcome_unknown", status: null });
      expect((error as OutcomeUnknownError).hint).toBe(
        "The old token may already be revoked. Try a request with it; if it fails, the new token was lost and the account needs support.",
      );
    },
  );

  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "CERT_HAS_EXPIRED",
  ])("treats the connection-setup failure %s as not sent, body or no body", async (code) => {
    const rotate = stubFetch([{ error: networkError(code) }]);
    await expect(
      call("never", { method: "POST", path: "/v1/agent/credentials/rotate" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(rotate.calls).toBe(1);
    const mutate = failAfterBody(networkError(code));
    await expect(
      call("mutate", { method: "POST", path: "/v1/org/custody", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(mutate).toHaveBeenCalledTimes(4);
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

describe("failure messages name the underlying error", () => {
  const CLAIM = {
    method: "POST",
    path: "/v1/agent/accounts/sg_1/claim",
    body: JSON.stringify({ claim_secret: "x" }),
  };

  it("names the error type, its message and the nested cause code in a NetworkError", async () => {
    stubFetch([{ error: networkError("ECONNREFUSED") }]);
    const error = await call("safe", { cfg: config(fakeClock(), { maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toBe(
      "The request failed before a response arrived (TypeError: fetch failed; code ECONNREFUSED).",
    );
    expect(((error as NetworkError).cause as Error).name).toBe("TypeError");
    expect(((error as NetworkError).cause as Error).message).toBe("fetch failed");
  });

  it("names the type alone when the error has no message and no code", async () => {
    stubFetch([{ error: new RangeError("") }]);
    const error = await call("safe", { cfg: config(fakeClock(), { maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    expect((error as NetworkError).message).toBe(
      "The request failed before a response arrived (RangeError).",
    );
  });

  it("names a thrown string as a string", async () => {
    // A string is not an Error on purpose: the SDK must describe whatever a fetch throws.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    vi.stubGlobal("fetch", () => Promise.reject("boom"));
    const error = await call("safe", { cfg: config(fakeClock(), { maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    expect((error as NetworkError).message).toBe(
      "The request failed before a response arrived (thrown string: boom).",
    );
  });

  it("redacts a token inside the original message from the new message", async () => {
    stubFetch([{ error: new TypeError(`fetch failed for ${TOKEN}`) }]);
    const error = await call("safe", { cfg: config(fakeClock(), { maxRetries: 0 }) }).catch(
      (e: unknown) => e,
    );
    const message = (error as NetworkError).message;
    expect(message).toMatch(
      /^The request failed before a response arrived \(TypeError: fetch failed for /,
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN.slice(12));
  });

  it("names the underlying error in an OutcomeUnknownError, redacted", async () => {
    stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await call("never", CLAIM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).message).toBe(
      "The request failed before a response arrived (TypeError: fetch failed; code ECONNRESET). The request was sent, so its outcome is unknown.",
    );
    stubFetch([{ error: new TypeError(`reset ${TOKEN}`) }]);
    const leaky = await call("never", CLAIM).catch((e: unknown) => e);
    expect((leaky as OutcomeUnknownError).message).not.toContain(TOKEN.slice(12));
    expect((leaky as OutcomeUnknownError).message).toContain("(TypeError: reset ");
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

describe("signed URLs and secrets stay out of wrapped messages (R96)", () => {
  const SIG = "9f2c41d7a0b5c3e8f1a2b3c4d5e6f708";
  const PART = `https://acct.r2.example.com/bucket/obj?partNumber=3&X-Amz-Signature=${SIG}`;

  function expectNowhere(error: unknown, secret: string): void {
    const wrapped = error as NetworkError;
    const cause = wrapped.cause as Error;
    expect(wrapped.message).not.toContain(secret);
    expect(cause.message).not.toContain(secret);
    expect(cause.stack).not.toContain(secret);
    expect(inspect(wrapped, { depth: 6 })).not.toContain(secret);
  }

  it("redacts the signature a failing part PUT's message quotes", async () => {
    stubFetch([{ error: new TypeError(`request to ${PART} failed, reason: socket hang up`) }]);
    const error = await hardenedFetch(config(fakeClock(), { maxRetries: 0 }), "safe")(PART, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toBe(
      "The request failed before a response arrived (TypeError: request to https://acct.r2.example.com/bucket/obj?[redacted] failed, reason: socket hang up).",
    );
    expect(((error as NetworkError).cause as Error).message).toBe(
      "request to https://acct.r2.example.com/bucket/obj?[redacted] failed, reason: socket hang up",
    );
    expectNowhere(error, SIG);
  });

  it("redacts the signature of a URL the Request constructor refuses", async () => {
    const stub = stubFetch([{ status: 200, body: {} }]);
    const error = await hardenedFetch(config(fakeClock(), { maxRetries: 0 }), "safe")(
      `http://[bad/obj?X-Amz-Signature=${SIG}`,
      { method: "PUT", body: new Uint8Array([1]) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({ code: "unexpected_error", status: null });
    expect((error as HushscriptError).message).toBe(
      "The SDK failed unexpectedly before the request was sent (TypeError: Failed to parse URL from http://[bad/obj?[redacted]).",
    );
    expectNowhere(error, SIG);
    expect(stub.calls).toBe(0);
  });
});

describe("outcome unknown after a sent unrepeatable call (spec 7.4)", () => {
  const SIGNUP = { method: "POST", path: "/v1/agent/accounts", body: "{}" };
  const CLAIM = {
    method: "POST",
    path: "/v1/agent/accounts/sg_1/claim",
    body: JSON.stringify({ claim_secret: "x" }),
  };
  const ROTATE = { method: "POST", path: "/v1/agent/credentials/rotate" };

  /** Reads the request body, then waits for the request's own signal. */
  function stallAfterSend(): StubFetch {
    return stubFetch([
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              reject(request.signal.reason as Error);
            },
            { once: true },
          );
        }),
    ]);
  }

  async function abortedCall(
    options: { method: string; path: string; body?: string },
    abortAfter: () => Promise<void> | void,
  ): Promise<unknown> {
    const controller = new AbortController();
    const pending = call("never", {
      ...options,
      signal: controller.signal,
      cfg: config(fakeClock({ manual: true })),
    }).catch((e: unknown) => e);
    await abortAfter();
    controller.abort();
    return pending;
  }

  // The stub counts a call once it has read the whole body, so a counted call is a sent request.
  const sentBy = (stub: StubFetch) => (): Promise<void> =>
    vi.waitFor(() => {
      expect(stub.calls).toBeGreaterThan(0);
    });

  it("raises OutcomeUnknownError with the claim hint when the caller aborts after the body was sent", async () => {
    const error = await abortedCall(CLAIM, sentBy(stallAfterSend()));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "outcome_unknown", status: null });
    expect((error as OutcomeUnknownError).hint).toBe(
      "The claim may have succeeded. Retrying will fail with agent_claim_invalid. If you have no token, contact support with the signup id.",
    );
    expect(((error as OutcomeUnknownError).cause as Error).name).toBe("AbortError");
    expect(((error as OutcomeUnknownError).cause as { code?: string }).code).toBe("aborted");
  });

  it("does the same for a bodyless rotate", async () => {
    const error = await abortedCall(ROTATE, sentBy(stallAfterSend()));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "outcome_unknown", status: null });
    expect((error as OutcomeUnknownError).hint).toBe(
      "The old token may already be revoked. Try a request with it; if it fails, the new token was lost and the account needs support.",
    );
    expect(((error as OutcomeUnknownError).cause as Error).name).toBe("AbortError");
  });

  it("does the same for an agent signup, without a hint", async () => {
    const error = await abortedCall(SIGNUP, sentBy(stallAfterSend()));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toBeNull();
    expect(((error as OutcomeUnknownError).cause as Error).name).toBe("AbortError");
  });

  it("raises a plain AbortError when the caller aborts before the body was written", async () => {
    // This stub never reads the body, so the request cannot have been sent.
    const f = vi.fn(hang);
    vi.stubGlobal("fetch", f);
    const error = await abortedCall(CLAIM, () =>
      vi.waitFor(() => {
        expect(f).toHaveBeenCalled();
      }),
    );
    expect(error).toBeInstanceOf(AbortError);
  });

  it("raises a plain AbortError for an abort during a GET", async () => {
    const stub = stallAfterSend();
    const controller = new AbortController();
    const pending = call("safe", {
      signal: controller.signal,
      cfg: config(fakeClock({ manual: true })),
    }).catch((e: unknown) => e);
    await sentBy(stub)();
    controller.abort();
    expect(await pending).toBeInstanceOf(AbortError);
  });

  it("raises OutcomeUnknownError with no hint for a signup lost after sending", async () => {
    const f = stubFetch([{ error: networkError("ECONNRESET") }]);
    const error = await call("never", SIGNUP).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toBeNull();
    expect(f.calls).toBe(1);
  });

  it("raises OutcomeUnknownError for a signup that timed out after sending", async () => {
    // The auto clock resolves the timeout sleep at once, after the stub has read the body.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      await new Request(input, init).arrayBuffer();
      return hang(input, init);
    });
    const error = await call("never", {
      ...SIGNUP,
      cfg: config(fakeClock(), { timeout: 7 }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).message).toMatch(/timed out/i);
    expect((error as OutcomeUnknownError).hint).toBeNull();
  });
});

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
  it.each([false, true])("wires 300 s to every upload PUT (proxied=%s)", async (proxied) => {
    const clock = fakeClock({ manual: true });
    const fake = fakeApi({ proxied, parts: 3 });
    const hs = new Hushscript({ token: TOKEN, baseUrl: BASE, clock });
    const media = Uint8Array.from([0x49, 0x44, 0x33, ...new Uint8Array(27)]);
    const transcript = await driven(
      hs.transcribe(media, { durationSeconds: 20, concurrency: 1 }),
      clock,
    );
    expect(transcript.id).toBe("tr_1");
    expect(fake.count(proxied ? "part" : "r2")).toBe(proxied ? 1 : 3);
    expect(clock.sleeps.filter((ms) => ms === 300_000)).toEqual(
      proxied ? [300_000] : [300_000, 300_000, 300_000],
    );
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
    const transport = stubFetch([{ error: networkError("ECONNRESET") }]);
    await call("never", {
      method: "POST",
      path: "/v1/agent/credentials/rotate?x=1",
      body: JSON.stringify({ title: "my secret title" }),
      headers: { Authorization: `Bearer ${TOKEN}`, "x-private-header": "private-header-value" },
      cfg: config(fakeClock(), { logLevel: "debug" }, lines),
    }).catch(() => undefined);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(lines).toEqual([
      "hushscript POST /v1/agent/credentials/rotate status=network_error attempt=1 duration_ms=0",
    ]);
    const text = lines.join("\n");
    expect(text).toContain("status=network_error");
    expect(text).not.toContain("secret title");
    expect(text).not.toContain("x=1");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("private-header-value");
  });

  it("logs a direct-to-storage URL as r2:part/{n} without its signature", async () => {
    const lines: string[] = [];
    stubFetch([{ status: 200, body: {} }]);
    const cfg = config(fakeClock(), { logLevel: "debug" }, lines);
    await hardenedFetch(cfg, "safe")(
      "https://acct.r2.cloudflarestorage.com/bucket/uploads/job_1/audio.mp3?partNumber=7&uploadId=up_abc&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef",
      {
        method: "PUT",
        body: "x",
      },
    );
    expect(lines).toEqual(["hushscript PUT r2:part/7 status=200 attempt=1 duration_ms=0"]);
  });

  it("logs a storage URL with no part number as r2:part, whatever its last path segment", async () => {
    const lines: string[] = [];
    stubFetch([{ status: 200, body: {} }]);
    const cfg = config(fakeClock(), { logLevel: "debug" }, lines);
    await hardenedFetch(cfg, "safe")(
      "https://acct.r2.cloudflarestorage.com/bucket/uploads/job_1/9?X-Amz-Signature=deadbeef",
      { method: "PUT", body: "x" },
    );
    expect(lines).toEqual(["hushscript PUT r2:part status=200 attempt=1 duration_ms=0"]);
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
      headers: { "x-a": "1", "x-b": "2" },
    });
    expect(f.requests[0]?.method).toBe("PUT");
    expect(f.requests[0]?.headers.get("x-a")).toBe("1");
    expect(f.requests[0]?.headers.get("x-b")).toBe("2");
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

describe("request bodies and redirects", () => {
  async function bodyChunks(body: unknown): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- stable in every Node 22 release we test
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(value);
    }
  }

  it("hands a Uint8Array body to the transport without copying it (spec 8.4 memory bound)", async () => {
    const bytes = new Uint8Array(600_000).fill(7);
    const seen: Uint8Array[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      seen.push(...(await bodyChunks(init?.body)));
      return new Response("{}", { status: 200 });
    });
    await hardenedFetch(config(), "idempotent")(`${BASE}/v1/uploads/j/parts/1`, {
      method: "PUT",
      body: bytes,
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((chunk) => chunk.buffer === bytes.buffer)).toBe(true);
    expect(seen.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(bytes.byteLength);
  });

  it("sends the same bytes again on a retry, still without a copy", async () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    const sent: Uint8Array[][] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      sent.push(await bodyChunks(init?.body));
      return new Response("{}", { status: sent.length === 1 ? 503 : 200 });
    });
    await hardenedFetch(config(), "idempotent")(`${BASE}/v1/uploads/j/parts/1`, {
      method: "PUT",
      body: bytes,
    });
    expect(sent).toHaveLength(2);
    for (const chunks of sent) {
      expect(chunks.every((chunk) => chunk.buffer === bytes.buffer)).toBe(true);
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    }
  });

  it("never follows a redirect, and turns a 3xx into an error (spec 7.2)", async () => {
    const f = stubFetch([{ status: 302, headers: { location: "https://evil.example/x" } }]);
    const error = await call("safe").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(302);
    expect(f.calls).toBe(1);
  });

  it("asks the transport for manual redirect handling on every request", async () => {
    const modes: unknown[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      modes.push(init?.redirect);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    await call("safe");
    await hardenedFetch(config(), "safe")(`${BASE}/v1/account`, { redirect: "follow" });
    expect(modes).toEqual(["manual", "manual"]);
  });

  it("sends Authorization only to the API origin", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    const headers = { authorization: `Bearer ${TOKEN}` };
    await hardenedFetch(config(), "safe")(`${BASE}/v1/account`, { headers });
    await hardenedFetch(config(), "safe")("https://storage.example/part", { headers });
    expect(f.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(f.requests[1]?.headers.get("authorization")).toBeNull();
  });
});

describe("the token of a request that waits", () => {
  const ROTATED = "hsr1:eu:rotated-token-not-in-the-usual-shape-0123456789";

  /** A config whose clock swaps the token the first time anything but the request timeout sleeps. */
  function rotatingConfig(): ResolvedConfig {
    const base = fakeClock();
    let rotated = false;
    const clock: Clock = {
      now: () => base.now(),
      sleep: (ms, signal) => {
        if (!rotated && ms !== TEST_TIMEOUT_SECONDS * 1000) {
          rotated = true;
          cfg.setToken(ROTATED);
        }
        return base.sleep(ms, signal);
      },
    };
    const cfg: ResolvedConfig = config(clock);
    return cfg;
  }

  it("is the one in force at the retry, not the one the request was built with", async () => {
    const f = stubFetch([
      { status: 503, text: "unavailable" },
      { status: 200, body: {} },
    ]);
    await call("safe", { cfg: rotatingConfig(), headers: { authorization: `Bearer ${TOKEN}` } });
    expect(f.requests.map((r) => r.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${ROTATED}`,
    ]);
  });

  it("is the one in force when a paced create finally goes out", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    const cfg = rotatingConfig();
    for (let i = 0; i < 4; i += 1) await cfg.createPacer.acquire();
    await call("upload-create", {
      cfg,
      method: "POST",
      path: "/v1/uploads",
      body: JSON.stringify({ idempotency_key: "0123456789abcdef0123" }),
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(f.requests[0]?.headers.get("authorization")).toBe(`Bearer ${ROTATED}`);
  });

  it("is never added to a request that carried none", async () => {
    const f = stubFetch([
      { status: 503, text: "unavailable" },
      { status: 200, body: {} },
    ]);
    await call("safe", { cfg: rotatingConfig() });
    expect(f.requests.map((r) => r.headers.get("authorization"))).toEqual([null, null]);
  });
});

describe("against a real HTTP server", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server?.closeAllConnections();
  });

  async function listen(
    handler: (
      request: IncomingMessage,
      count: number,
    ) => { status: number; body?: string; headers?: Record<string, string> },
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
        response.writeHead(reply.status, {
          "content-type": "application/json",
          ...reply.headers,
        });
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

  it("does not follow a redirect to another host", async () => {
    vi.unstubAllGlobals();
    const target = await listen(() => ({ status: 200 }));
    const targetServer = server;
    const origin = await listen(() => ({
      status: 302,
      headers: { location: `${target.url}/stolen` },
    }));
    const error = await hardenedFetch(
      config(),
      "safe",
    )(`${origin.url}/v1/x`).catch((e: unknown) => e);
    targetServer?.close();
    targetServer?.closeAllConnections();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(302);
    expect(origin.seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it("sends a body larger than one chunk intact", async () => {
    vi.unstubAllGlobals();
    const { url, seen } = await listen(() => ({ status: 200 }));
    const body = "x".repeat(700_000);
    await hardenedFetch(config(), "safe")(`${url}/v1/x`, { method: "PUT", body });
    expect(seen[0]?.body.length).toBe(700_000);
    expect(seen[0]?.length).toBe("700000");
  });

  it("treats a refused connection as not sent even with a body: claim is a NetworkError, mutate is retried", async () => {
    vi.unstubAllGlobals();
    const { url } = await listen(() => ({ status: 200 }));
    server?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const clock = fakeClock();
    const cfg = config(clock, { maxRetries: 1 });
    await expect(
      hardenedFetch(cfg, "never")(`${url}/v1/agent/accounts/sg_1/claim`, {
        method: "POST",
        body: JSON.stringify({ claim_secret: "x" }),
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(clock.sleeps).toEqual([]);
    await expect(
      hardenedFetch(cfg, "mutate")(`${url}/v1/org/custody`, { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(NetworkError);
    // the mutation was judged unsent and replayed once: one backoff sleep
    expect(clock.sleeps).toHaveLength(1);
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
