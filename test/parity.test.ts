import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { ApiError, ConfigurationError, HushscriptError, PreflightError } from "../src/errors";
import { paginate } from "../src/paginate";
import { encodeResumeToken } from "../src/transcribe/resume";
import {
  BASE,
  JOB_OPTIONS,
  LIMITS,
  TEST_TIMEOUT_SECONDS,
  TOKEN,
  fakeClock,
  stubFetch,
  type Step,
} from "./helpers";
import { driven, fakeApi } from "./transcribe/fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(clock = fakeClock()): Hushscript {
  return new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

const JOB = {
  id: "j1",
  state: "done",
  mode: "standard",
  declared_seconds: 21,
  verified_seconds: 20,
  actual_seconds: 20,
  billable_seconds: 20,
  error: null,
  failure_kind: null,
  retry_of: null,
  created_at: 1,
  transcript_id: "tr_1",
  options: JOB_OPTIONS,
};
const ROW = {
  id: "tr_1",
  title: "T",
  language_detected: null,
  duration_seconds: 30,
  created_at: 1_760_000_000,
  auto_delete_at: null,
  tags: [],
};
const TRANSCRIPT = {
  id: "tr_9",
  title: "T",
  language_detected: "en",
  duration_seconds: 3,
  speaker_names: {},
  tags: [],
  created_at: 1,
  updated_at: 2,
  auto_delete_at: null,
  edited: false,
  body: { version: 1, original: { utterances: [] }, translations: {} },
};
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

describe("R52: an empty next_cursor ends a list walk like null", () => {
  it('stops paginate() at an empty cursor without asking for a page named ""', async () => {
    const asked: (string | null)[] = [];
    const items = await drain(
      paginate((cursor) => {
        asked.push(cursor);
        return Promise.resolve({ items: [1, 2], nextCursor: "" });
      }),
    );
    expect(items).toEqual([1, 2]);
    expect(asked).toEqual([null]);
  });

  it("ends every resource walk and hands a manual page() reader null", async () => {
    const f = stubFetch([
      { status: 200, body: { transcripts: [ROW], next_cursor: "" } },
      { status: 200, body: { jobs: [JOB], next_cursor: "" } },
      { status: 200, body: { deleted: [], next_cursor: "" } },
      { status: 200, body: { transactions: [], next_cursor: "" } },
      { status: 200, body: { entries: [], next_cursor: "" } },
      { status: 200, body: { holds: [], next_cursor: "" } },
      { status: 200, body: { transcripts: [ROW], next_cursor: "" } },
    ]);
    const hs = client();
    expect(await drain(hs.transcripts.list())).toHaveLength(1);
    expect(await drain(hs.jobs.list())).toHaveLength(1);
    await drain(hs.transcripts.deleted());
    await drain(hs.billing.transactions());
    await drain(hs.billing.ledger());
    await drain(hs.billing.holds());
    expect(f.calls).toBe(6);
    expect((await hs.transcripts.page()).nextCursor).toBeNull();
  });
});

describe("R53: an id that cannot be one path segment is refused before any request", () => {
  const badIds: [string, unknown][] = [
    ["empty", ""],
    ["dot", "."],
    ["dot dot", ".."],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["a lone high surrogate", "tr_\uD800"],
    ["a lone low surrogate", "\uDC00x"],
  ];
  const calls: [string, (hs: Hushscript, id: string) => Promise<unknown>][] = [
    ["jobs.get", (hs, id) => hs.jobs.get(id)],
    ["jobs.wait", (hs, id) => hs.jobs.wait(id)],
    ["transcripts.get", (hs, id) => hs.transcripts.get(id)],
    ["agent.claim", (_hs, id) => Hushscript.agent.claim(id, "secret", { baseUrl: BASE })],
  ];

  for (const [call, run] of calls) {
    for (const [name, id] of badIds) {
      it(`${call} with ${name} is invalid_option and sends nothing`, async () => {
        const f = stubFetch([{ status: 200, body: {} }]);
        const error = await failure(run(client(), id as string));
        expect(error).toBeInstanceOf(PreflightError);
        expect(error).toMatchObject({ code: "invalid_option", status: null });
        expect(f.calls).toBe(0);
      });
    }
  }

  it("sends every other id percent-encoded as one segment", async () => {
    const cases: [string, string][] = [
      ["a/b", "a%2Fb"],
      ["x y?z#w", "x%20y%3Fz%23w"],
      ["%2e%2e", "%252e%252e"],
      ["..a", "..a"],
      ["a..", "a.."],
      ["ключ", "%D0%BA%D0%BB%D1%8E%D1%87"],
      ["\u{1F600}", "%F0%9F%98%80"],
    ];
    for (const [id, encoded] of cases) {
      const f = stubFetch([{ status: 404, body: { error: "not_found", code: 4040 } }]);
      const hs = client();
      await failure(hs.jobs.get(id));
      await failure(hs.transcripts.get(id));
      await failure(Hushscript.agent.claim(id, "secret", { baseUrl: BASE }));
      expect(f.requests.map((r) => new URL(r.url).pathname)).toEqual([
        `/v1/jobs/${encoded}`,
        `/v1/transcripts/${encoded}`,
        `/v1/agent/accounts/${encoded}/claim`,
      ]);
    }
  });

  it("refuses a resume token whose job id is malformed as config_invalid, before any request", async () => {
    const f = stubFetch([{ status: 200, body: {} }]);
    for (const jobId of ["", ".", "..", "j\uD800"]) {
      const token = encodeResumeToken({
        jobId,
        idempotencyKey: "0123456789abcdefghij",
        size: 10,
        durationSeconds: 20,
      });
      const error = await failure(client().resume(token));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ code: "config_invalid" });
    }
    expect(f.calls).toBe(0);
  });

  it("treats an unusable job id in a create answer, or transcript id in a job, as bad_response", async () => {
    const MEDIA = Uint8Array.from([0x49, 0x44, 0x33, ...Array.from({ length: 17 }, () => 0)]);
    for (const [name, hook] of [
      ["job id in a create", "create"],
      ["transcript id in a job", "job"],
    ] as const) {
      const clock = fakeClock({ manual: true });
      const fake = fakeApi({
        hooks:
          hook === "create"
            ? {
                create: () => Response.json({ job_id: "..", state: "uploading", upload: null }),
              }
            : {
                job: () => Response.json({ ...JOB, transcript_id: ".." }),
              },
      });
      const hs = client(clock);
      const error = await failure(driven(hs.transcribe(MEDIA, { durationSeconds: 20 }), clock));
      expect(error, name).toBeInstanceOf(ApiError);
      expect(error, name).toMatchObject({ code: "bad_response" });
      expect(fake.count("transcript"), name).toBe(0);
    }
  });
});

describe("R53: an error body that does not parse, however deeply nested, is non-JSON", () => {
  const DEPTH = 200_000;
  const bodies: Record<string, string> = {
    "deep arrays": "[".repeat(DEPTH) + "]".repeat(DEPTH),
    "deep objects": `{"error":"unauthorized","code":1,"a":${'{"a":'.repeat(DEPTH)}1${"}".repeat(DEPTH)}}`,
    "deep array in a key": `{"error":"unauthorized","code":1,"d":${"[".repeat(DEPTH)}${"]".repeat(DEPTH)}}`,
    unterminated: "[".repeat(DEPTH),
  };
  for (const [name, text] of Object.entries(bodies)) {
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      it(`${name} on a ${String(status)} raises only a HushscriptError`, async () => {
        stubFetch([{ status, text }]);
        const error = await failure(client().jobs.get("j1"));
        expect(error).toBeInstanceOf(HushscriptError);
        expect(error).not.toBeInstanceOf(RangeError);
        expect(error).toMatchObject({ status, code: `http_${String(status)}` });
      });
    }
  }

  it("keeps the code of an ordinary shallow error body", async () => {
    stubFetch([{ status: 401, body: { error: "unauthorized", code: 1, details: { a: [1] } } }]);
    expect(await failure(client().jobs.get("j1"))).toMatchObject({ code: "unauthorized" });
  });

  it("answers a deeply nested 2xx body with a typed result, never a RangeError", async () => {
    const deep = `,"extra":${"[".repeat(DEPTH)}${"]".repeat(DEPTH)}`;
    stubFetch([{ status: 200, text: `${JSON.stringify(JOB).slice(0, -1)}${deep}}` }]);
    expect((await client().jobs.get("j1")).id).toBe("j1");
    stubFetch([{ status: 200, text: "[".repeat(DEPTH) }]);
    const error = await failure(client().jobs.get("j1"));
    expect(error).toMatchObject({ code: "bad_response", status: 200 });
  });
});

interface TwoXXCall {
  name: string;
  path: string;
  good: unknown;
  bad: unknown;
  run: (hs: Hushscript) => Promise<unknown>;
}

const PURCHASE = { status: "ok", balance_seconds: 600 };
const SIGNUP = {
  signup_id: "su_1",
  claim_secret: "cs",
  checkout_url: "https://pay.example/c",
  amount: 199,
  currency: "usd",
  expires_at: 1_760_000_000,
};
const CLAIM = { pat: TOKEN, user_id: "u1", scopes: ["transcribe"], balance_seconds: 2700 };
const ACCOUNT = {
  balance_seconds: 5,
  held_seconds: 0,
  credits_expire_at: null,
  card_on_file: false,
  data_region: "eu",
  limits: LIMITS,
};

const TWO_XX_CALLS: TwoXXCall[] = [
  {
    name: "account",
    path: "/v1/account",
    good: ACCOUNT,
    bad: { balance_seconds: "x" },
    run: (hs) => hs.account(),
  },
  { name: "balance", path: "/v1/account", good: ACCOUNT, bad: {}, run: (hs) => hs.balance() },
  {
    name: "jobs.get",
    path: "/v1/jobs/j1",
    good: JOB,
    bad: { id: "j1" },
    run: (hs) => hs.jobs.get("j1"),
  },
  {
    name: "jobs.wait",
    path: "/v1/jobs/j1",
    good: JOB,
    bad: { id: "j1" },
    run: (hs) => hs.jobs.wait("j1"),
  },
  {
    name: "jobs.list",
    path: "/v1/jobs",
    good: { jobs: [JOB], next_cursor: null },
    bad: { jobs: [{ id: "j1" }] },
    run: (hs) => drain(hs.jobs.list()),
  },
  {
    name: "transcripts.list",
    path: "/v1/transcripts",
    good: { transcripts: [ROW], next_cursor: null },
    bad: { transcripts: [{ id: 5 }] },
    run: (hs) => drain(hs.transcripts.list()),
  },
  {
    name: "transcripts.page",
    path: "/v1/transcripts",
    good: { transcripts: [ROW], next_cursor: null },
    bad: {},
    run: (hs) => hs.transcripts.page(),
  },
  {
    name: "transcripts.get",
    path: "/v1/transcripts/tr_9",
    good: TRANSCRIPT,
    bad: { id: "tr_9" },
    run: (hs) => hs.transcripts.get("tr_9"),
  },
  {
    name: "transcripts.deleted",
    path: "/v1/transcripts/deleted",
    good: {
      deleted: [
        {
          id: "d1",
          title: "A",
          duration_seconds: 30,
          created_at: 1_760_000_000,
          deleted_at: 1_760_000_500,
          cause: "manual",
          receipt: null,
        },
      ],
      next_cursor: null,
    },
    bad: { deleted: [{ id: "d1" }] },
    run: (hs) => drain(hs.transcripts.deleted()),
  },
  {
    name: "billing.packs",
    path: "/v1/billing/packs",
    good: {
      packs: [
        { id: "45min", seconds: 2700, amount: 199, currency: "usd", referral_bonus_seconds: 0 },
      ],
    },
    bad: { packs: [{ id: "45min" }] },
    run: (hs) => hs.billing.packs(),
  },
  {
    name: "billing.cards",
    path: "/v1/billing/cards",
    good: CARDS,
    bad: { default_id: null },
    run: (hs) => hs.billing.cards(),
  },
  {
    name: "billing.setDefaultCard",
    path: "/v1/billing/cards/default",
    good: { ok: true },
    bad: {},
    run: (hs) => hs.billing.setDefaultCard("pm_1"),
  },
  {
    name: "billing.addCardUrl",
    path: "/v1/billing/setup-session",
    good: { checkout_url: "https://pay.example/setup", expires_at: 1_760_000_000 },
    bad: {},
    run: (hs) => hs.billing.addCardUrl(),
  },
  {
    name: "billing.buy",
    path: "/v1/billing/purchase",
    good: PURCHASE,
    bad: { status: "ok" },
    run: (hs) => hs.billing.buy("45min"),
  },
  {
    name: "billing.transactions",
    path: "/v1/billing/transactions",
    good: {
      transactions: [
        {
          id: 7,
          seconds: 18_000,
          amount_cents: 599,
          amount_refunded_cents: 0,
          currency: "usd",
          status: "succeeded",
          created_at: 1_760_000_000,
          payment_method_type: "card",
          payment_method_brand: "visa",
          payment_method_last4: "4242",
          receipt_number: "HS-1",
          initiated_via: null,
        },
      ],
      next_cursor: null,
    },
    bad: { transactions: [{ id: 7 }] },
    run: (hs) => drain(hs.billing.transactions()),
  },
  {
    name: "billing.ledger",
    path: "/v1/billing/ledger",
    good: {
      entries: [
        {
          id: 3,
          delta_seconds: -60,
          kind: "settle",
          job_id: "j1",
          note: null,
          created_at: 1_760_000_001,
        },
      ],
      next_cursor: null,
    },
    bad: { entries: [{ id: 3 }] },
    run: (hs) => drain(hs.billing.ledger()),
  },
  {
    name: "billing.holds",
    path: "/v1/billing/holds",
    good: {
      holds: [{ id: "j1", kind: "transcription", seconds: 120, created_at: 1_760_000_002 }],
      next_cursor: null,
    },
    bad: { holds: [{ id: "j1" }] },
    run: (hs) => drain(hs.billing.holds()),
  },
  {
    name: "agent.signup",
    path: "/v1/agent/accounts",
    good: SIGNUP,
    bad: { signup_id: "su_1" },
    run: () =>
      Hushscript.agent.signup({
        email: "a@example.com",
        pack: "45min",
        acceptTerms: "2026-10-01",
        agent: { name: "Scribe", platform: "custom" },
        baseUrl: BASE,
      }),
  },
];

function serve(call: TwoXXCall, status: number, body: unknown): Step {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (path === call.path) {
      return status === 204 || status === 205
        ? new Response(null, { status })
        : Response.json(body, { status });
    }
    if (path === "/v1/billing/cards") return Response.json(CARDS);
    return Response.json({ error: "not_found", code: 4040 }, { status: 404 });
  };
}

describe("R58: success is any 2xx with a usable body, on every operation", () => {
  for (const status of [200, 201, 202, 203]) {
    for (const call of TWO_XX_CALLS) {
      it(`${call.name} accepts a ${String(status)} with a usable body`, async () => {
        stubFetch([serve(call, status, call.good)]);
        await call.run(client());
      });

      it(`${call.name} reports an unusable ${String(status)} as bad_response with that status`, async () => {
        stubFetch([serve(call, status, call.bad)]);
        const error = await failure(call.run(client()));
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ code: "bad_response", status });
      });
    }
  }

  for (const call of TWO_XX_CALLS) {
    it(`${call.name} reports a 204 as bad_response with status 204`, async () => {
      stubFetch([serve(call, 204, null)]);
      const error = await failure(call.run(client()));
      expect(error).toMatchObject({ code: "bad_response", status: 204 });
    });
  }

  it("reads a claim and a rotate answered with a non-200 2xx like a 200", async () => {
    for (const status of [201, 202, 203]) {
      stubFetch([{ status, body: CLAIM }]);
      expect((await Hushscript.agent.claim("su_1", "cs", { baseUrl: BASE })).token).toBe(TOKEN);
      stubFetch([{ status, body: { pat: TOKEN, pat_id: "p1", scopes: [], expires_at: null } }]);
      expect((await client().agent.rotateToken()).token).toBe(TOKEN);
    }
  });
});
