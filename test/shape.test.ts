import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { ApiError, HushscriptError, OutcomeUnknownError, UploadError } from "../src/errors";
import { clearSecrets, redact } from "../src/redact";
import { describeProblem, objectOf, positiveIntAtMost, str, timestamp, url } from "../src/shape";
import { UPLOAD_CREATE } from "../src/shapes";
import {
  BASE,
  JOB_OPTIONS,
  LIMITS,
  TEST_TIMEOUT_SECONDS,
  TOKEN,
  fakeClock,
  stubFetch,
  type Step,
  type ManualClock,
} from "./helpers";
import { driven } from "./transcribe/fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(clock: ManualClock = fakeClock()): Hushscript {
  return new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
}

async function drain(items: AsyncIterable<unknown>): Promise<void> {
  const seen: unknown[] = [];
  for await (const item of items) seen.push(item);
}

const CARD = {
  id: "pm_1",
  type: "card",
  brand: "visa",
  last4: "4242",
  exp_month: 12,
  exp_year: 2099,
  email: null,
  is_default: true,
  fast_checkout_eligible: true,
};
const CARDS = { default_id: "pm_1", methods: [CARD] };
const JOB = {
  id: "job_1",
  state: "done",
  mode: "standard",
  declared_seconds: 21,
  verified_seconds: 20,
  actual_seconds: 20,
  billable_seconds: 20,
  error: null,
  failure_kind: null,
  retry_of: null,
  created_at: 1_760_000_000,
  transcript_id: "tr_1",
  private_result_expires_at: null,
  private_result_available: false,
  options: JOB_OPTIONS,
};
const UTTERANCES = { utterances: [{ speaker: "A", start_ms: 0, end_ms: 900, text: "hi" }] };
const TRANSCRIPT = {
  id: "tr_1",
  title: "T",
  language_detected: "en",
  duration_seconds: 20,
  speaker_names: { A: "Ana" },
  tags: ["a"],
  created_at: 1_760_000_000,
  updated_at: 1_760_000_100,
  auto_delete_at: null,
  edited: false,
  body: { version: 1, original: UTTERANCES, translations: { es: UTTERANCES } },
};

interface Case {
  name: string;
  valid: unknown;
  /** One path whose value, replaced by an object, is the wrong type. */
  wrong: (string | number)[];
  run: (hs: Hushscript) => Promise<unknown>;
  /** The requests the call makes; the answer under test is the last one. */
  steps?: (answer: Step) => Step[];
  /** The error a call raises for an unusable answer, where it is not a `bad_response` itself. */
  lost?: boolean;
  /** The call is recovered from, so `bad_response` is the cause of the `parts_exhausted` it raises. */
  exhausted?: boolean;
  /** A JSON `null` is a real answer (the job takes proxied parts), not a malformed one. */
  nullable?: boolean;
  /** The call heartbeats and sleeps: run it on a manual clock that a driver steps. */
  driven?: boolean;
}

const ACCOUNT_BODY = {
  balance_seconds: 600,
  held_seconds: 0,
  credits_expire_at: null,
  card_on_file: true,
  data_region: "eu",
  limits: LIMITS,
};
/** Twenty bytes the sniffer takes for an mp3; a part size of one makes twenty parts of it. */
const MEDIA = Uint8Array.from([0x49, 0x44, 0x33, ...Array.from({ length: 17 }, () => 0)]);

function partUrls(from: number): { n: number; url: string }[] {
  return Array.from({ length: 21 - from }, (_, index) => ({
    n: from + index,
    url: `${BASE}/__r2/job_1/${String(from + index)}`,
  }));
}

function createBody(urls: { n: number; url: string }[], next: number | null): unknown {
  return {
    job_id: "job_1",
    state: "uploading",
    upload: { part_size_bytes: 1, total_parts: 20, part_urls: urls, next_part_number: next },
  };
}

/** Every request an upload makes, answered correctly except the one `target`, which gets `answer`. */
function uploadSteps(
  target: "create" | "part-urls" | "complete",
  create: unknown,
): (answer: Step) => Step[] {
  const reply = (body: unknown): Response => Response.json(body);
  return (answer) => [
    (request) => {
      const { pathname } = new URL(request.url);
      const route = pathname.endsWith("/part-urls")
        ? "part-urls"
        : pathname.endsWith("/complete")
          ? "complete"
          : pathname === "/v1/uploads"
            ? "create"
            : null;
      if (route !== null && route === target && "status" in answer) {
        return new Response(answer.text ?? JSON.stringify(answer.body), { status: answer.status });
      }
      if (pathname === "/v1/account") return reply(ACCOUNT_BODY);
      if (route === "create") return reply(create);
      if (route === "part-urls") return reply({ part_urls: partUrls(3), next_part_number: null });
      if (route === "complete") return reply({ state: "done" });
      if (pathname.startsWith("/__r2/")) {
        return new Response("", { status: 200, headers: { etag: `"etag-${pathname}"` } });
      }
      if (pathname.endsWith("/heartbeat")) return reply({ ok: true });
      if (pathname.startsWith("/v1/jobs/")) return reply(JOB);
      return reply(TRANSCRIPT);
    },
  ];
}

const CASES: Case[] = [
  {
    name: "hs.account",
    valid: {
      balance_seconds: 60,
      held_seconds: 0,
      credits_expire_at: 1_760_000_000,
      card_on_file: true,
      data_region: "eu",
      limits: LIMITS,
    },
    wrong: ["limits", "max_daily_seconds"],
    run: (hs) => hs.account(),
  },
  {
    name: "hs.balance",
    valid: {
      balance_seconds: 60,
      held_seconds: 0,
      credits_expire_at: null,
      card_on_file: true,
      data_region: "eu",
      limits: LIMITS,
    },
    wrong: ["balance_seconds"],
    run: (hs) => hs.balance(),
  },
  {
    name: "billing.packs",
    valid: {
      packs: [
        { id: "300min", amount: 599, currency: "USD", seconds: 18_000, referral_bonus_seconds: 0 },
      ],
    },
    wrong: ["packs", 0, "amount"],
    run: (hs) => hs.billing.packs(),
  },
  {
    name: "billing.cards",
    valid: CARDS,
    wrong: ["methods", 0, "fast_checkout_eligible"],
    run: (hs) => hs.billing.cards(),
  },
  {
    name: "billing.setDefaultCard",
    valid: { ok: true },
    wrong: ["ok"],
    run: (hs) => hs.billing.setDefaultCard("pm_1"),
  },
  {
    name: "billing.addCardUrl",
    valid: {
      checkout_url: "https://pay.example/c/1",
      session_id: "cs_1",
      expires_at: 1_760_000_000,
    },
    wrong: ["checkout_url"],
    run: (hs) => hs.billing.addCardUrl(),
  },
  {
    name: "billing.buy",
    valid: { status: "ok", balance_seconds: 18_000 },
    wrong: ["balance_seconds"],
    steps: (answer) => [{ status: 200, body: CARDS }, answer],
    run: (hs) => hs.buy("300min"),
  },
  {
    name: "billing.transactions",
    valid: {
      transactions: [
        {
          id: 1,
          seconds: 18_000,
          amount_cents: 599,
          amount_refunded_cents: 0,
          currency: "usd",
          status: "paid",
          created_at: 1_760_000_000,
          payment_method_type: "card",
          payment_method_brand: "visa",
          payment_method_last4: "4242",
          receipt_number: "R-1",
          initiated_via: "api",
        },
      ],
      next_cursor: null,
      account_reference: "acc",
    },
    wrong: ["transactions", 0, "created_at"],
    run: (hs) => drain(hs.billing.transactions()),
  },
  {
    name: "billing.ledger",
    valid: {
      entries: [
        {
          id: 1,
          delta_seconds: -60,
          kind: "settle",
          job_id: "job_1",
          note: null,
          created_at: 1_760_000_000,
        },
      ],
      next_cursor: null,
    },
    wrong: ["entries", 0, "delta_seconds"],
    run: (hs) => drain(hs.billing.ledger()),
  },
  {
    name: "billing.holds",
    valid: {
      holds: [{ id: "h1", kind: "transcription", seconds: 60, created_at: 1_760_000_000 }],
      next_cursor: null,
    },
    wrong: ["holds", 0, "seconds"],
    run: (hs) => drain(hs.billing.holds()),
  },
  {
    name: "jobs.list",
    valid: { jobs: [JOB], next_cursor: null },
    wrong: ["jobs", 0, "options", "keyterms"],
    run: (hs) => drain(hs.jobs.list()),
  },
  {
    name: "jobs.get",
    valid: JOB,
    wrong: ["state"],
    run: (hs) => hs.jobs.get("job_1"),
  },
  {
    name: "transcripts.page",
    valid: {
      transcripts: [
        {
          id: "tr_1",
          title: "T",
          language_detected: null,
          duration_seconds: 30,
          created_at: 1_760_000_000,
          auto_delete_at: null,
          tags: ["a"],
          options: JOB_OPTIONS,
          insights_state: "none",
        },
      ],
      next_cursor: null,
    },
    wrong: ["transcripts", 0, "tags"],
    run: (hs) => hs.transcripts.page(),
  },
  {
    name: "transcripts.get",
    valid: TRANSCRIPT,
    wrong: ["body", "original", "utterances", 0, "text"],
    run: (hs) => hs.transcripts.get("tr_1"),
  },
  {
    name: "transcripts.deleted",
    valid: {
      deleted: [
        {
          id: "tr_1",
          title: "T",
          duration_seconds: 30,
          created_at: 1_760_000_000,
          deleted_at: 1_760_000_500,
          cause: "manual",
          receipt: { type: "r", items: [] },
        },
      ],
      next_cursor: null,
    },
    wrong: ["deleted", 0, "deleted_at"],
    run: (hs) => drain(hs.transcripts.deleted()),
  },
  {
    name: "upload.create",
    valid: createBody(partUrls(1), null),
    wrong: ["upload", "part_size_bytes"],
    driven: true,
    steps: uploadSteps("create", createBody(partUrls(1), null)),
    run: (hs) => hs.transcribe(MEDIA, { durationSeconds: 20, concurrency: 1 }),
  },
  {
    name: "upload.part-urls",
    valid: { part_urls: partUrls(3), next_part_number: null },
    wrong: ["part_urls", 0, "n"],
    driven: true,
    exhausted: true,
    nullable: true,
    steps: uploadSteps("part-urls", createBody(partUrls(1).slice(0, 2), 3)),
    run: (hs) => hs.transcribe(MEDIA, { durationSeconds: 20, concurrency: 1 }),
  },
  {
    name: "upload.complete",
    valid: { state: "done" },
    wrong: ["state"],
    driven: true,
    steps: uploadSteps("complete", createBody(partUrls(1), null)),
    run: (hs) => hs.transcribe(MEDIA, { durationSeconds: 20, concurrency: 1 }),
  },
  {
    name: "agent.signup",
    valid: {
      signup_id: "hsr1:eu:abc",
      claim_secret: "cs_1",
      checkout_url: "https://pay.example/c/1",
      pack: "45min",
      amount: 599,
      currency: "USD",
      expires_at: 1_760_000_000,
    },
    wrong: ["amount"],
    run: () =>
      Hushscript.agent.signup({
        email: "a@example.com",
        pack: "45min",
        acceptTerms: "v1",
        agent: { name: "x", platform: "y" },
        baseUrl: BASE,
      }),
  },
  {
    name: "agent.claim",
    valid: {
      user_id: "usr_1",
      pat: "hsr1:eu:claimed-token-0123456789",
      scopes: ["account:read"],
      balance_seconds: 2700,
    },
    wrong: ["pat"],
    lost: true,
    run: () => Hushscript.agent.claim("hsr1:eu:abc", "cs_1", { baseUrl: BASE }),
  },
  {
    name: "agent.rotateToken",
    valid: {
      pat: "hsr1:eu:rotated-token-0123456789",
      pat_id: "pat_2",
      scopes: ["account:read"],
      expires_at: 1_800_000_000,
    },
    wrong: ["pat"],
    lost: true,
    run: (hs) => hs.agent.rotateToken(),
  },
];

const ACCOUNT_FIELDS = [
  "balance_seconds",
  "held_seconds",
  "credits_expire_at",
  "card_on_file",
  "data_region",
  "limits",
  ...["max_daily_seconds", "max_active_jobs", "active_jobs", "used_today_seconds"].map(
    (key) => `limits.${key}`,
  ),
];
const JOB_FIELDS = [
  "id",
  "state",
  "mode",
  "declared_seconds",
  "verified_seconds",
  "actual_seconds",
  "billable_seconds",
  "error",
  "failure_kind",
  "retry_of",
  "created_at",
  "transcript_id",
  "options",
  ...[
    "language_code",
    "speaker_detection",
    "medical_mode",
    "multichannel",
    "translation_targets",
    "keyterms",
    "prompt",
    "auto_generate_insights",
  ].map((key) => `options.${key}`),
];
const listFields = (collection: string, fields: string[]): string[] => [
  collection,
  "next_cursor",
  ...fields.map((field) => `${collection}.0.${field}`),
];

// Required fields read by the friendly layer. Optional/unread fields are deliberately outside this table:
// packs.available; setup session_id/expires_at; transactions.account_reference;
// job private-result/fetch fields; transcript matter_code/client_code and summary options/insights_state;
// envelope.version; upload-create balance_seconds/held_seconds/limits/funding;
// upload-complete ok/verified_seconds/balance_seconds/held_seconds; account purchases_remaining_in_window;
// opaque speaker-name/translation keys and deletion receipt contents; part-page next_part_number;
// signup.pack; claim/rotate fields other than the credential (spec 7.4 permits their absence).
const REQUIRED_FIELDS: Record<string, string[]> = {
  "hs.account": ACCOUNT_FIELDS,
  "hs.balance": ACCOUNT_FIELDS,
  "billing.packs": [
    "packs",
    ...["id", "amount", "currency", "seconds", "referral_bonus_seconds"].map(
      (field) => `packs.0.${field}`,
    ),
  ],
  "billing.cards": [
    "default_id",
    "methods",
    ...[
      "id",
      "type",
      "brand",
      "last4",
      "exp_month",
      "exp_year",
      "email",
      "is_default",
      "fast_checkout_eligible",
    ].map((field) => `methods.0.${field}`),
  ],
  "billing.setDefaultCard": ["ok"],
  "billing.addCardUrl": ["checkout_url"],
  "billing.buy": ["status", "balance_seconds"],
  "billing.transactions": listFields("transactions", [
    "id",
    "seconds",
    "amount_cents",
    "amount_refunded_cents",
    "currency",
    "status",
    "created_at",
    "payment_method_type",
    "payment_method_brand",
    "payment_method_last4",
    "receipt_number",
    "initiated_via",
  ]),
  "billing.ledger": listFields("entries", [
    "id",
    "delta_seconds",
    "kind",
    "job_id",
    "note",
    "created_at",
  ]),
  "billing.holds": listFields("holds", ["id", "kind", "seconds", "created_at"]),
  "jobs.list": listFields("jobs", JOB_FIELDS),
  "jobs.get": JOB_FIELDS,
  "transcripts.page": listFields("transcripts", [
    "id",
    "title",
    "language_detected",
    "duration_seconds",
    "created_at",
    "auto_delete_at",
    "tags",
  ]),
  "transcripts.get": [
    "id",
    "title",
    "language_detected",
    "duration_seconds",
    "speaker_names",
    "tags",
    "created_at",
    "updated_at",
    "auto_delete_at",
    "edited",
    "body",
    "body.original",
    "body.translations",
    ...["body.original", "body.translations.es"].flatMap((prefix) => [
      `${prefix}.utterances`,
      ...["speaker", "start_ms", "end_ms", "text"].map(
        (field) => `${prefix}.utterances.0.${field}`,
      ),
    ]),
  ],
  "transcripts.deleted": listFields("deleted", [
    "id",
    "title",
    "duration_seconds",
    "created_at",
    "deleted_at",
    "cause",
    "receipt",
  ]),
  "upload.create": [
    "job_id",
    "state",
    "upload",
    "upload.part_size_bytes",
    "upload.total_parts",
    "upload.part_urls",
    "upload.next_part_number",
    "upload.part_urls.0.n",
    "upload.part_urls.0.url",
  ],
  "upload.part-urls": ["part_urls", "part_urls.0.n", "part_urls.0.url"],
  "upload.complete": ["state"],
  "agent.signup": ["signup_id", "claim_secret", "checkout_url", "amount", "currency", "expires_at"],
  "agent.claim": ["pat"],
  "agent.rotateToken": ["pat"],
};

function stepsFor(testCase: Case, answer: Step): Step[] {
  return testCase.steps?.(answer) ?? [answer];
}

function withAt(value: unknown, path: (string | number)[], replacement: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  const copy: unknown = structuredClone(value);
  const holder = copy as Record<string | number, unknown>;
  holder[head] = withAt(holder[head], rest, replacement);
  return copy;
}

function withoutAt(value: unknown, path: (string | number)[]): unknown {
  const copy: unknown = structuredClone(value);
  const parent = path
    .slice(0, -1)
    .reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], copy);
  const last = path.at(-1);
  if (last !== undefined) Reflect.deleteProperty(parent as object, last);
  return copy;
}

function allPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key];
    return [path, ...allPaths(item, path)];
  });
}

async function outcome(testCase: Case, answer: Step): Promise<unknown> {
  stubFetch(stepsFor(testCase, answer));
  const clock = fakeClock({ manual: testCase.driven === true });
  const running = testCase.run(client(clock));
  return (testCase.driven === true ? driven(running, clock) : running).then(
    () => null,
    (error: unknown) => error,
  );
}

function expectBadResponse(testCase: Case, error: unknown): void {
  if (testCase.lost === true) {
    // A lost credential: the cause is a redacted copy of the bad_response.
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "outcome_unknown", status: null });
    expect((error as OutcomeUnknownError).cause).toMatchObject({
      name: "ApiError",
      code: "bad_response",
    });
    return;
  }
  if (testCase.exhausted === true) {
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ code: "parts_exhausted", status: null });
    // The cause is the redacted copy an error carries, which keeps the code and not the status.
    expect((error as UploadError).cause).toMatchObject({ name: "ApiError", code: "bad_response" });
    return;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "bad_response", status: 200, numericCode: null });
}

/** A claim or rotate registers whatever string came back as a secret: forget them once the runs end. */
async function isolatingSecrets(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } finally {
    clearSecrets();
  }
}

describe("every body the friendly layer maps", () => {
  it.each(CASES)("$name answers a valid body", async (testCase) => {
    expect(await outcome(testCase, { status: 200, body: testCase.valid })).toBeNull();
  });

  it.each(CASES)("$name raises bad_response for {}", async (testCase) => {
    expectBadResponse(testCase, await outcome(testCase, { status: 200, body: {} }));
  });

  it.each(CASES)("$name raises bad_response for a wrong-typed field", async (testCase) => {
    const body = withAt(testCase.valid, testCase.wrong, { not: "that" });
    expectBadResponse(testCase, await outcome(testCase, { status: 200, body }));
  });

  it.each(CASES)("$name raises bad_response for a body that is not JSON", async (testCase) => {
    expectBadResponse(testCase, await outcome(testCase, { status: 200, text: "<html></html>" }));
  });

  it.each(CASES)("$name raises bad_response for JSON null and an array", async (testCase) => {
    if (testCase.nullable !== true) {
      expectBadResponse(testCase, await outcome(testCase, { status: 200, text: "null" }));
    }
    expectBadResponse(testCase, await outcome(testCase, { status: 200, body: [] }));
  });

  it.each(CASES)(
    "$name raises bad_response when any required field is missing",
    async (testCase) => {
      const missing = REQUIRED_FIELDS[testCase.name];
      expect(missing).toBeDefined();
      if (missing === undefined) throw new Error(`required fields missing for ${testCase.name}`);
      expect(missing.length).toBeGreaterThan(0);
      for (const dotted of missing) {
        const path = dotted.split(".").map((key) => (/^\d+$/.test(key) ? Number(key) : key));
        expect(allPaths(testCase.valid)).toContainEqual(path);
        const answer: Step = { status: 200, body: withoutAt(testCase.valid, path) };
        expectBadResponse(testCase, await outcome(testCase, answer));
      }
    },
  );

  it.each([
    ["upload.create", ["upload", "part_size_bytes"]],
    ["upload.create", ["upload", "total_parts"]],
    ["upload.create", ["upload", "part_urls", 0, "n"]],
    ["upload.create", ["upload", "next_part_number"]],
    ["upload.part-urls", ["part_urls", 0, "n"]],
    ["upload.part-urls", ["next_part_number"]],
  ] as [string, (string | number)[]][])(
    "%s refuses a count that is zero, negative or not whole at %j",
    async (name, path) => {
      const testCase = CASES.find((candidate) => candidate.name === name);
      expect(testCase).toBeDefined();
      if (testCase === undefined) return;
      for (const count of [0, -1, 1.5]) {
        const body = withAt(testCase.valid, path, count);
        expectBadResponse(testCase, await outcome(testCase, { status: 200, body }));
      }
    },
  );

  it("raises nothing but SDK errors for a random JSON object, whichever call reads it", async () => {
    await isolatingSecrets(() =>
      fc.assert(
        fc.asyncProperty(fc.constantFrom(...CASES), fc.jsonValue(), async (testCase, body) => {
          const error = await outcome(testCase, { status: 200, body });
          if (error !== null) expect(error).toBeInstanceOf(HushscriptError);
        }),
      ),
    );
  });

  it("raises nothing but SDK errors when one field of a valid body is deleted or replaced", async () => {
    const mutated = fc.constantFrom(...CASES).chain((testCase) =>
      fc
        .tuple(fc.constantFrom(...allPaths(testCase.valid)), fc.boolean(), fc.jsonValue())
        .map(([path, drop, junk]) => ({
          testCase,
          body: drop ? withoutAt(testCase.valid, path) : withAt(testCase.valid, path, junk),
        })),
    );
    await isolatingSecrets(() =>
      fc.assert(
        fc.asyncProperty(mutated, async ({ testCase, body }) => {
          const error = await outcome(testCase, { status: 200, body });
          if (error !== null) expect(error).toBeInstanceOf(HushscriptError);
        }),
      ),
    );
  });

  it("leaves no random token registered as a secret once a property run ends", async () => {
    const rotate = CASES.find((testCase) => testCase.name === "agent.rotateToken");
    if (rotate === undefined) throw new Error("no rotate case");
    const random = "random-string-from-a-property-run";
    await isolatingSecrets(async () => {
      await outcome(rotate, { status: 200, body: { pat: random } });
      expect(redact(random)).not.toBe(random);
    });
    expect(redact(random)).toBe(random);
  });
});

describe("a response with a currency the SDK cannot format", () => {
  it("still answers packs, with the plain amount and code", async () => {
    stubFetch([
      {
        status: 200,
        body: {
          packs: [
            {
              id: "45min",
              amount: 599,
              currency: "ZZZZ",
              seconds: 2700,
              referral_bonus_seconds: 0,
            },
          ],
        },
      },
    ]);
    const [pack] = await client().billing.packs();
    expect(pack?.price).toEqual({ amount: 599, currency: "ZZZZ", formatted: "5.99 ZZZZ" });
  });
});

describe("the shape combinators", () => {
  it("name the path and what was expected", () => {
    const shape = objectOf<{ a: unknown }>({
      a: objectOf<{ b: unknown }>({ b: str }),
    });
    const found = shape({ a: { b: 1 } });
    expect(found).not.toBeNull();
    expect(describeProblem(found ?? { path: [], expected: "" })).toBe("a.b: expected a string");
    expect(describeProblem({ path: [], expected: "an object" })).toBe("expected an object");
    expect(describeProblem({ path: ["rows", 2, "id"], expected: "a string" })).toBe(
      "rows[2].id: expected a string",
    );
  });

  it("accept an out-of-range time and a URL that cannot be parsed only as failures", () => {
    expect(timestamp(1_760_000_000)).toBeNull();
    expect(timestamp(1e15)).not.toBeNull();
    expect(url("https://a.test/x")).toBeNull();
    expect(url("http://")).not.toBeNull();
  });

  it("bound a whole number from 1 up to and including the maximum", () => {
    const shape = positiveIntAtMost(33_554_432);
    expect(shape(1)).toBeNull();
    expect(shape(33_554_432)).toBeNull();
    for (const value of [0, -1, 2.5, 33_554_433, "7", null]) expect(shape(value)).not.toBeNull();
    expect(describeProblem(shape(33_554_433) ?? { path: [], expected: "" })).toBe(
      "expected a positive whole number up to 33554432",
    );
  });

  it("let an upload create answer carry a part size from 8 MiB up to exactly 32 MiB", () => {
    const answer = (partSize: number): unknown => ({
      job_id: "job_1",
      state: "uploading",
      upload: {
        part_size_bytes: partSize,
        total_parts: 3,
        part_urls: null,
        next_part_number: null,
      },
    });
    for (const partSize of [8_388_608, 33_554_432]) {
      expect(UPLOAD_CREATE(answer(partSize))).toBeNull();
    }
    expect(UPLOAD_CREATE(answer(33_554_433))).not.toBeNull();
  });

  it("never echo a value, so a body with a secret in it is not copied into an error", async () => {
    const secret = "secret-value-that-must-not-leak";
    stubFetch([{ status: 200, body: { packs: [{ id: secret, amount: secret }] } }]);
    const error: unknown = await client()
      .billing.packs()
      .catch((e: unknown) => e);
    const text = JSON.stringify([
      (error as Error).message,
      ((error as Error).cause as Error).message,
    ]);
    expect(text).not.toContain(secret);
  });
});
