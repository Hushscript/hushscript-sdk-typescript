import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import {
  AuthenticationError,
  PaymentMethodRequiredError,
  PermissionDeniedError,
  PreflightError,
} from "../src/errors";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): Hushscript {
  return new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock: fakeClock(),
    timeout: TEST_TIMEOUT_SECONDS,
  });
}

function card(id: string, eligible = true, isDefault = false): Record<string, unknown> {
  return {
    id,
    type: "card",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2099,
    email: null,
    is_default: isDefault,
    fast_checkout_eligible: eligible,
  };
}

function cards(
  defaultId: string | null,
  methods: Record<string, unknown>[],
): { status: number; body: unknown } {
  return { status: 200, body: { default_id: defaultId, methods } };
}

const PURCHASED = { status: 200, body: { status: "ok", balance_seconds: 18_000 } };
const ACCOUNT = {
  status: 200,
  body: {
    balance_seconds: 18_000,
    held_seconds: 120,
    credits_expire_at: 1_800_000_000,
    card_on_file: true,
    data_region: "eu",
    limits: { max_daily_seconds: 36_000 },
  },
};

function purchaseBodies(stub: {
  requests: Request[];
  bodies: string[];
}): Record<string, unknown>[] {
  return stub.requests.flatMap((request, index) =>
    new URL(request.url).pathname === "/v1/billing/purchase"
      ? [JSON.parse(stub.bodies[index] ?? "{}") as Record<string, unknown>]
      : [],
  );
}

describe("hs.billing.packs", () => {
  it("maps seconds to minutes, keeps the API's price and defaults available to true", async () => {
    stubFetch([
      {
        status: 200,
        body: {
          packs: [
            { id: "45min", amount: 599, currency: "USD", seconds: 2700, referral_bonus_seconds: 0 },
            {
              id: "300min",
              amount: 3499,
              currency: "EUR",
              seconds: 18_000,
              referral_bonus_seconds: 650,
              available: false,
            },
          ],
        },
      },
    ]);
    expect(await client().billing.packs()).toEqual([
      {
        id: "45min",
        seconds: 2700,
        minutes: 45,
        price: { amount: 599, currency: "USD", formatted: "$5.99" },
        bonusMinutes: 0,
        available: true,
      },
      {
        id: "300min",
        seconds: 18_000,
        minutes: 300,
        price: { amount: 3499, currency: "EUR", formatted: "€34.99" },
        bonusMinutes: 10,
        available: false,
      },
    ]);
  });
});

describe("hs.billing cards", () => {
  it("camelCases the saved cards and the default id", async () => {
    stubFetch([cards("pm_a", [card("pm_a", true, true)])]);
    expect(await client().billing.cards()).toEqual({
      defaultId: "pm_a",
      cards: [
        {
          id: "pm_a",
          type: "card",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2099,
          email: null,
          isDefault: true,
          fastCheckoutEligible: true,
        },
      ],
    });
  });

  it("sets the default card by payment method id", async () => {
    const stub = stubFetch([{ status: 200, body: { ok: true } }]);
    await expect(client().billing.setDefaultCard("pm_b")).resolves.toBeUndefined();
    expect(new URL(stub.requests[0]?.url ?? "").pathname).toBe("/v1/billing/cards/default");
    expect(JSON.parse(stub.bodies[0] ?? "")).toEqual({ payment_method_id: "pm_b" });
  });

  it("returns the hosted setup page URL, retrying one 502 with the same key", async () => {
    const stub = stubFetch([
      { status: 502, text: "bad gateway" },
      {
        status: 200,
        body: {
          checkout_url: "https://checkout.example.com/s/1",
          session_id: "cs_1",
          expires_at: 1,
        },
      },
    ]);
    expect(await client().billing.addCardUrl()).toBe("https://checkout.example.com/s/1");
    expect(stub.calls).toBe(2);
    const keys = stub.bodies.map(
      (body) => (JSON.parse(body) as { idempotency_key?: string }).idempotency_key,
    );
    expect(keys[0]).toMatch(/^[\da-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("billing history", () => {
  it("walks every page of transactions and turns timestamps into dates", async () => {
    const row = (id: number): Record<string, unknown> => ({
      id,
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
    });
    const stub = stubFetch([
      { status: 200, body: { transactions: [row(2)], next_cursor: "c2", account_reference: "a" } },
      { status: 200, body: { transactions: [row(1)], next_cursor: null, account_reference: "a" } },
    ]);
    const seen = [];
    for await (const transaction of client().billing.transactions()) seen.push(transaction);
    expect(seen.map((t) => t.id)).toEqual([2, 1]);
    expect(seen[0]).toMatchObject({
      amountCents: 3499,
      amountRefundedCents: 0,
      receiptNumber: "HS-1",
      createdAt: new Date(1_760_000_000_000),
    });
    expect(new URL(stub.requests[1]?.url ?? "").searchParams.get("cursor")).toBe("c2");
  });

  it("walks the ledger and the active holds", async () => {
    stubFetch([
      {
        status: 200,
        body: {
          entries: [
            {
              id: 9,
              delta_seconds: -60,
              kind: "settle",
              job_id: "j1",
              note: null,
              created_at: 100,
            },
          ],
          next_cursor: null,
        },
      },
      {
        status: 200,
        body: {
          holds: [{ id: "j2", kind: "transcription", seconds: 600, created_at: 200 }],
          next_cursor: null,
        },
      },
    ]);
    const hs = client();
    const entries = [];
    for await (const entry of hs.billing.ledger()) entries.push(entry);
    expect(entries).toEqual([
      {
        id: 9,
        deltaSeconds: -60,
        kind: "settle",
        jobId: "j1",
        note: null,
        createdAt: new Date(100_000),
      },
    ]);
    const holds = [];
    for await (const hold of hs.billing.holds()) holds.push(hold);
    expect(holds).toEqual([
      { id: "j2", kind: "transcription", seconds: 600, createdAt: new Date(200_000) },
    ]);
  });
});

describe("hs.buy", () => {
  it("uses the default card, mints one key and returns the balance from the purchase response", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true), card("pm_b")]),
      { status: 200, body: { status: "ok", balance_seconds: 20_000 } },
      ACCOUNT,
    ]);
    const balance = await client().buy("300min");
    const [purchase] = purchaseBodies(stub);
    expect(purchase).toMatchObject({
      pack: "300min",
      quick_payment_method_id: "pm_a",
      policy_ack: false,
    });
    expect(purchase?.["idempotency_key"]).toMatch(/^[\da-f-]{36}$/);
    expect(balance).toEqual({
      seconds: 20_000,
      minutes: 333,
      heldSeconds: 120,
      expiresAt: new Date(1_800_000_000_000),
      purchasesRemaining: null,
    });
  });

  it("uses the only eligible card when there is no default", async () => {
    const stub = stubFetch([
      cards(null, [card("pm_old", false), card("pm_ok")]),
      PURCHASED,
      ACCOUNT,
    ]);
    await client().buy("45min");
    expect(purchaseBodies(stub)[0]).toMatchObject({ quick_payment_method_id: "pm_ok" });
  });

  it.each([
    ["no card at all", cards(null, [])],
    ["only a card that cannot be charged off-session", cards(null, [card("pm_x", false)])],
    ["several eligible cards and no default", cards(null, [card("pm_1"), card("pm_2")])],
  ])("raises PaymentMethodRequiredError and sends no purchase with %s", async (_name, saved) => {
    const stub = stubFetch([saved]);
    const error: unknown = await client()
      .buy("300min")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentMethodRequiredError);
    expect(error).toMatchObject({ code: "no_default_card" });
    expect(purchaseBodies(stub)).toEqual([]);
    expect(stub.calls).toBe(1);
  });

  it("sends policy_ack true only when the caller acknowledges the no-refund notice", async () => {
    const stub = stubFetch([
      (request) => {
        const path = new URL(request.url).pathname;
        const answer =
          path === "/v1/billing/cards"
            ? cards("pm_a", [card("pm_a", true, true)])
            : path === "/v1/billing/purchase"
              ? PURCHASED
              : ACCOUNT;
        return Response.json(answer.body, { status: answer.status });
      },
    ]);
    await client().buy("300min", { acknowledgeNoRefund: true });
    await client().buy("300min", { acknowledgeNoRefund: false });
    await client().buy("300min");
    expect(purchaseBodies(stub).map((body) => body["policy_ack"])).toEqual([true, false, false]);
  });

  it("sends a caller's idempotency key as it is, and refuses a malformed one before any request", async () => {
    const stub = stubFetch([cards("pm_a", [card("pm_a", true, true)]), PURCHASED, ACCOUNT]);
    await client().buy("300min", { idempotencyKey: "order_42-retry" });
    expect(purchaseBodies(stub)[0]).toMatchObject({ idempotency_key: "order_42-retry" });
    const calls = stub.calls;
    for (const key of ["", "has space", "a".repeat(129), "ünï"]) {
      const error: unknown = await client()
        .buy("300min", { idempotencyKey: key })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option" });
    }
    expect(stub.calls).toBe(calls);
  });

  it("retries one 502 on the purchase with the same key and charges once", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true)]),
      { status: 502, text: "bad gateway" },
      PURCHASED,
      ACCOUNT,
    ]);
    await client().buy("300min");
    const bodies = purchaseBodies(stub);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.["idempotency_key"]).toBe(bodies[0]?.["idempotency_key"]);
  });

  it("does not retry a refusal, and the error says to buy in the app", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true)]),
      { status: 403, body: { error: "pat_purchase_requires_app", code: 4021 } },
    ]);
    const error: unknown = await client()
      .buy("300min")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error).toMatchObject({ code: "pat_purchase_requires_app" });
    expect(purchaseBodies(stub)).toHaveLength(1);
  });

  it("is the same call as hs.billing.buy", async () => {
    const stub = stubFetch([cards("pm_a", [card("pm_a", true, true)]), PURCHASED, ACCOUNT]);
    const hs = client();
    await hs.billing.buy("300min");
    expect(purchaseBodies(stub)).toHaveLength(1);
    expect(typeof hs.buy).toBe("function");
  });

  it("does not catch an error from reading the cards", async () => {
    stubFetch([{ status: 401, body: { error: "unauthorized", code: 2000 } }]);
    await expect(client().buy("300min")).rejects.toBeInstanceOf(AuthenticationError);
  });
});
