import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import type { Clock } from "../src/clock";
import { HushscriptError, OutcomeUnknownError } from "../src/errors";
import { parseRetryAfter } from "../src/http/retry";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch, type Step } from "./helpers";
import { driven, fakeApi } from "./transcribe/fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = "purchase-key-0123456789";
const NINES = "9".repeat(400);
const CARDS = {
  default_id: "pm_1",
  methods: [
    {
      id: "pm_1",
      type: "card",
      brand: "visa",
      last4: "4242",
      exp_month: 1,
      exp_year: 2030,
      email: null,
      is_default: true,
      fast_checkout_eligible: true,
    },
  ],
};

function client(clock: Clock = fakeClock()): Hushscript {
  return new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
}

/** Cards answer normally; the purchase answers `purchase`. */
function purchaseStep(purchase: () => Response): Step {
  return (request) =>
    new URL(request.url).pathname === "/v1/billing/cards" ? Response.json(CARDS) : purchase();
}

function text(status: number, body: string, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("R61: Retry-After is read totally", () => {
  it.each([
    ["400 digits", NINES],
    ["a number past the safe integers", "9007199254740993"],
    ["a date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a negative number", "-5"],
    ["a decimal", "1.5"],
    ["an exponent", "1e400"],
    ["empty", ""],
  ])("counts %s as absent", (_name, header) => {
    expect(parseRetryAfter(header)).toBeNull();
  });

  it("reads whole seconds", () => {
    expect(parseRetryAfter(" 120 ")).toBe(120);
  });
});

describe("R61: a purchase fails only as a HushscriptError that carries its key", () => {
  it("is a success when a 200 purchase carries a 400-digit Retry-After", async () => {
    stubFetch([
      purchaseStep(
        text(200, JSON.stringify({ status: "ok", balance_seconds: 600 }), { "retry-after": NINES }),
      ),
    ]);
    expect(await client().billing.buy("45min", { idempotencyKey: KEY })).toEqual({
      seconds: 600,
      minutes: 10,
    });
  });

  for (const status of [402, 429, 502, 503]) {
    it(`keeps the key on a ${String(status)} with a 400-digit Retry-After, treated as absent`, async () => {
      stubFetch([
        purchaseStep(
          text(status, JSON.stringify({ error: "rate_limited", code: 1 }), {
            "retry-after": NINES,
          }),
        ),
      ]);
      const error = await failure(client().billing.buy("45min", { idempotencyKey: KEY }));
      expect(error).toBeInstanceOf(HushscriptError);
      expect(error).toMatchObject({ idempotencyKey: KEY, retryAfter: null, status });
    });
  }

  for (const [slug, status] of [
    ["insufficient_balance", 402],
    ["rate_limited", 429],
  ] as const) {
    for (const [name, details] of [
      ["1e400", '{"needed_seconds":1e400,"balance_seconds":1e400,"retry_after_seconds":1e400}'],
      ["NaN", '{"needed_seconds":NaN,"balance_seconds":-Infinity,"retry_after_seconds":NaN}'],
      [
        "a huge integer",
        `{"needed_seconds":${"9".repeat(400)},"retry_after_seconds":${"9".repeat(400)}}`,
      ],
    ] as const) {
      it(`keeps the key on a ${String(status)} whose details hold ${name}`, async () => {
        stubFetch([
          purchaseStep(
            text(
              status,
              `{"error":"${slug}","code":1e400,"needed_seconds":1e400,"details":${details},"allowed_packs":[1e400]}`,
            ),
          ),
        ]);
        const error = await failure(client().billing.buy("45min", { idempotencyKey: KEY }));
        expect(error).toBeInstanceOf(HushscriptError);
        expect(error).toMatchObject({
          idempotencyKey: KEY,
          status,
          retryAfter: null,
          numericCode: null,
        });
        const hint = (error as HushscriptError).hint ?? "";
        expect(hint).not.toMatch(/Infinity|NaN/);
      });
    }
  }

  it("keeps the key when something unexpected fails after the purchase went out", async () => {
    let reads = 0;
    const clock: Clock = {
      ...fakeClock(),
      now: () => {
        reads += 1;
        if (reads > 3) throw new TypeError("clock broke");
        return 0;
      },
    };
    stubFetch([purchaseStep(text(200, JSON.stringify({ status: "ok", balance_seconds: 600 })))]);
    const error = await failure(client(clock).billing.buy("45min", { idempotencyKey: KEY }));
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({ idempotencyKey: KEY });
    expect(((error as HushscriptError).cause as Error).message).toBe("clock broke");
  });
});

describe("R61: nothing but a HushscriptError escapes elsewhere", () => {
  it("turns an unexpected failure of a token rotation into an unknown outcome", async () => {
    let reads = 0;
    const clock: Clock = {
      ...fakeClock(),
      now: () => {
        reads += 1;
        if (reads > 1) throw new TypeError("clock broke");
        return 0;
      },
    };
    stubFetch([{ status: 200, body: { pat: TOKEN } }]);
    const error = await failure(
      new Hushscript({
        token: TOKEN,
        baseUrl: BASE,
        clock,
        timeout: TEST_TIMEOUT_SECONDS,
      }).agent.rotateToken(),
    );
    expect(error).toBeInstanceOf(OutcomeUnknownError);
  });

  it("does not call a failure before the request went out an unknown outcome", async () => {
    const clock: Clock = {
      ...fakeClock(),
      now: () => {
        throw new TypeError("clock broke");
      },
    };
    const fetchSpy = stubFetch([{ status: 200, body: { pat: TOKEN } }]);
    const error = await failure(
      new Hushscript({
        token: TOKEN,
        baseUrl: BASE,
        clock,
        timeout: TEST_TIMEOUT_SECONDS,
      }).agent.rotateToken(),
    );
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).not.toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "unexpected_error" });
    expect(fetchSpy.calls).toBe(0);
  });

  const MEDIA = Uint8Array.from([0x49, 0x44, 0x33, ...Array.from({ length: 17 }, () => 0)]);

  it("hands back, untouched, an error a progress callback throws while waiting", async () => {
    const clock = fakeClock({ manual: true });
    fakeApi({ jobFlow: [{ state: "processing", polls: 2 }, { state: "done" }] });
    const thrown = new TypeError("callback broke");
    const error = await failure(
      driven(
        client(clock).transcribe(MEDIA, {
          durationSeconds: 20,
          onProgress: (progress) => {
            if (progress.stage === "processing") throw thrown;
          },
        }),
        clock,
      ),
    );
    expect(error).toBe(thrown);
  });

  it("hands back, untouched, an error a progress callback throws during the upload", async () => {
    const clock = fakeClock({ manual: true });
    fakeApi();
    const thrown = new RangeError("upload callback broke");
    const error = await failure(
      driven(
        client(clock).transcribe(MEDIA, {
          durationSeconds: 20,
          onProgress: (progress) => {
            if (progress.stage === "uploading" && progress.bytesSent > 0) throw thrown;
          },
        }),
        clock,
      ),
    );
    expect(error).toBe(thrown);
  });

  it("hands back, untouched, an error onResumeToken throws", async () => {
    const clock = fakeClock({ manual: true });
    fakeApi();
    const thrown = new TypeError("token callback broke");
    const error = await failure(
      driven(
        client(clock).transcribe(MEDIA, {
          durationSeconds: 20,
          onResumeToken: () => {
            throw thrown;
          },
        }),
        clock,
      ),
    );
    expect(error).toBe(thrown);
  });

  it("hands back a thrown value that is not an Error, untouched", async () => {
    const clock = fakeClock({ manual: true });
    fakeApi();
    const error = await failure(
      driven(
        client(clock).transcribe(MEDIA, {
          durationSeconds: 20,
          onResumeToken: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
            throw "plain string";
          },
        }),
        clock,
      ),
    );
    expect(error).toBe("plain string");
  });

  it("hands back, untouched, an error a progress callback throws in resume()", async () => {
    const clock = fakeClock({ manual: true });
    fakeApi({ jobFlow: [{ state: "processing", polls: 2 }, { state: "done" }] });
    const hs = client(clock);
    const tokens: string[] = [];
    await driven(
      hs.transcribe(MEDIA, { durationSeconds: 20, onResumeToken: (t) => tokens.push(t) }),
      clock,
    );
    fakeApi({ jobFlow: [{ state: "processing", polls: 2 }, { state: "done" }] });
    const thrown = new TypeError("resume callback broke");
    const error = await failure(
      driven(
        hs.resume(tokens[0] ?? "", MEDIA, {
          onProgress: (progress) => {
            if (progress.stage === "processing") throw thrown;
          },
        }),
        clock,
      ),
    );
    expect(error).toBe(thrown);
  });

  it("still gives an unexpected failure inside the SDK after the send the key and the token", async () => {
    const clock = fakeClock({ manual: true });
    const api = fakeApi({ jobFlow: [{ state: "processing", polls: 2 }, { state: "done" }] });
    const flaky: Clock = {
      ...clock,
      now: () => {
        if (api.count("job") >= 1) throw new TypeError("clock broke");
        return clock.now();
      },
    };
    const error = await failure(
      driven(client(flaky).transcribe(MEDIA, { durationSeconds: 20 }), clock),
    );
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({ code: "unexpected_error" });
    expect((error as HushscriptError).idempotencyKey).not.toBeNull();
    expect((error as HushscriptError).resumeToken).not.toBeNull();
  });
});
