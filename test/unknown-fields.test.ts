import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import {
  JOB_OPTIONS,
  LIMITS,
  TEST_TIMEOUT_SECONDS,
  BASE,
  TOKEN,
  fakeClock,
  stubFetch,
} from "./helpers";
import type { Step } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CLAIMED_TOKEN = "hsr1:eu:claimed-token-not-in-the-usual-shape-0123456789";
const ROTATED_TOKEN = "hsr1:eu:rotated-token-not-in-the-usual-shape-0123456789";

function client(): Hushscript {
  return new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock: fakeClock(),
    timeout: TEST_TIMEOUT_SECONDS,
  });
}

// What a newer API might add: a snake_case field and a nested object.
const NEW = { new_server_field: "x", nested_extra: { inner_key: 1 } };
const NEW_CAMEL = { newServerField: "x", nestedExtra: { innerKey: 1 } };

const ACCOUNT = {
  balance_seconds: 18_000,
  held_seconds: 600,
  credits_expire_at: null,
  card_on_file: true,
  data_region: "eu",
  limits: LIMITS,
};
const JOB = {
  id: "j1",
  state: "done",
  mode: "standard",
  declared_seconds: 21,
  verified_seconds: 20,
  actual_seconds: null,
  billable_seconds: 0,
  error: null,
  failure_kind: null,
  retry_of: null,
  created_at: 1_760_000_000,
  transcript_id: null,
  private_result_expires_at: null,
  private_result_available: false,
  options: JOB_OPTIONS,
};
const SUMMARY = {
  id: "tr_1",
  title: "T",
  language_detected: "en",
  duration_seconds: 30,
  created_at: 1_760_000_000,
  auto_delete_at: null,
  tags: [],
  options: {},
  insights_state: "none",
};
const DELETED = {
  id: "d1",
  title: "T",
  duration_seconds: 30,
  created_at: 1,
  deleted_at: 2,
  cause: "manual",
  receipt: null,
};
const PACK = {
  id: "45min",
  amount: 599,
  currency: "USD",
  seconds: 2700,
  referral_bonus_seconds: 0,
};
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
const TRANSACTION = {
  id: 7,
  seconds: 18_000,
  amount_cents: 3499,
  amount_refunded_cents: 0,
  currency: "USD",
  status: "paid",
  created_at: 1_760_000_000,
  payment_method_type: "card",
  payment_method_brand: "visa",
  payment_method_last4: "4242",
  receipt_number: "HS-1",
  initiated_via: "pat",
};
const LEDGER = {
  id: 9,
  delta_seconds: -60,
  kind: "settle",
  job_id: "j1",
  note: null,
  created_at: 100,
};
const HOLD = { id: "j2", kind: "transcription", seconds: 600, created_at: 200 };

const ok = (body: unknown): Step => ({ status: 200, body });
const cardsStep = ok({ default_id: "pm_1", methods: [CARD] });

async function first<T>(items: AsyncIterable<T>): Promise<T> {
  for await (const item of items) return item;
  throw new Error("the list was empty");
}

interface Case {
  name: string;
  /** The steps to serve: the result's body carries NEW plus `clash`. */
  steps: (extra: Record<string, unknown>) => Step[];
  run: () => Promise<object>;
  /** Camel-cased name of a field the result maps itself, and its value. */
  known: [string, unknown];
}

const CASES: Case[] = [
  {
    name: "Account",
    steps: (extra) => [ok({ ...ACCOUNT, ...extra })],
    run: () => client().account(),
    known: ["balanceSeconds", 18_000],
  },
  {
    name: "Balance",
    steps: (extra) => [ok({ ...ACCOUNT, ...extra })],
    run: () => client().balance(),
    known: ["seconds", 18_000],
  },
  {
    name: "Job (get)",
    steps: (extra) => [ok({ ...JOB, ...extra })],
    run: () => client().jobs.get("j1"),
    known: ["declaredSeconds", 21],
  },
  {
    name: "Job (list)",
    steps: (extra) => [ok({ jobs: [{ ...JOB, ...extra }], next_cursor: null })],
    run: () => first(client().jobs.list()),
    known: ["declaredSeconds", 21],
  },
  {
    name: "Pack",
    steps: (extra) => [ok({ packs: [{ ...PACK, ...extra }] })],
    run: async () => (await client().billing.packs())[0] ?? {},
    known: ["minutes", 45],
  },
  {
    name: "Cards",
    steps: (extra) => [ok({ default_id: "pm_1", methods: [CARD], ...extra })],
    run: () => client().billing.cards(),
    known: ["defaultId", "pm_1"],
  },
  {
    name: "Card",
    steps: (extra) => [ok({ default_id: "pm_1", methods: [{ ...CARD, ...extra }] })],
    run: async () => (await client().billing.cards()).cards[0] ?? {},
    known: ["isDefault", true],
  },
  {
    name: "Purchase",
    steps: (extra) => [cardsStep, ok({ status: "ok", balance_seconds: 18_000, ...extra })],
    run: () => client().billing.buy("45min"),
    known: ["seconds", 18_000],
  },
  {
    name: "Transaction",
    steps: (extra) => [ok({ transactions: [{ ...TRANSACTION, ...extra }], next_cursor: null })],
    run: () => first(client().billing.transactions()),
    known: ["amountCents", 3499],
  },
  {
    name: "LedgerEntry",
    steps: (extra) => [ok({ entries: [{ ...LEDGER, ...extra }], next_cursor: null })],
    run: () => first(client().billing.ledger()),
    known: ["deltaSeconds", -60],
  },
  {
    name: "Hold",
    steps: (extra) => [ok({ holds: [{ ...HOLD, ...extra }], next_cursor: null })],
    run: () => first(client().billing.holds()),
    known: ["createdAt", new Date(200_000)],
  },
  {
    name: "TranscriptSummary",
    steps: (extra) => [ok({ transcripts: [{ ...SUMMARY, ...extra }], next_cursor: null })],
    run: () => first(client().transcripts.list()),
    known: ["durationSeconds", 30],
  },
  {
    name: "DeletedTranscript",
    steps: (extra) => [ok({ deleted: [{ ...DELETED, ...extra }], next_cursor: null })],
    run: () => first(client().transcripts.deleted()),
    known: ["durationSeconds", 30],
  },
  {
    name: "AgentSignup",
    steps: (extra) => [
      ok({
        signup_id: "hsr1:eu:abc",
        claim_secret: "cs_secret_0123456789",
        checkout_url: "https://checkout.example.com/pay/abc",
        pack: "45min",
        amount: 599,
        currency: "USD",
        expires_at: 1_760_001_800,
        ...extra,
      }),
    ],
    run: () =>
      Hushscript.agent.signup({
        email: "agent@example.com",
        pack: "45min",
        acceptTerms: "2026-01",
        agent: { name: "a", platform: "p" },
        baseUrl: BASE,
      }),
    known: ["signupId", "hsr1:eu:abc"],
  },
  {
    name: "AgentClaim",
    steps: (extra) => [
      ok({ pat: CLAIMED_TOKEN, user_id: "u1", scopes: ["a"], balance_seconds: 2700, ...extra }),
    ],
    run: () => Hushscript.agent.claim("sg_1", "cs_secret_0123456789", { baseUrl: BASE }),
    known: ["userId", "u1"],
  },
  {
    name: "RotatedToken",
    steps: (extra) => [
      ok({ pat: ROTATED_TOKEN, pat_id: "p2", scopes: ["a"], expires_at: null, ...extra }),
    ],
    run: () => client().agent.rotateToken(),
    known: ["tokenId", "p2"],
  },
];

describe("a field the API adds to a result is kept, camelized (R99)", () => {
  it.each(CASES)("$name keeps a new top-level field and a new nested object", async (c) => {
    stubFetch(c.steps(NEW));
    const result = await c.run();
    expect(result).toMatchObject(NEW_CAMEL);
    // Nothing leaks through under its raw name: every key is camelCase.
    expect(Object.keys(result).filter((key) => key.includes("_"))).toEqual([]);
  });

  it.each(CASES)("$name lets its own field win over a stray key of the same name", async (c) => {
    const [name, value] = c.known;
    stubFetch(c.steps({ [name]: "WRONG" }));
    expect(await c.run()).toHaveProperty(name, value);
  });

  it.each(CASES)("$name adds no field when the API adds none", async (c) => {
    stubFetch(c.steps({}));
    const result = await c.run();
    expect(result).not.toHaveProperty("newServerField");
    expect(Object.keys(result).filter((key) => key.includes("_"))).toEqual([]);
  });

  it("does not let a __proto__ key from the API reach the prototype", async () => {
    const body = JSON.parse(
      `${JSON.stringify(ACCOUNT).slice(0, -1)},"__proto__":{"polluted":true}}`,
    ) as object;
    stubFetch([ok(body)]);
    const account = await client().account();
    expect(Object.getPrototypeOf(account)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect((account as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
