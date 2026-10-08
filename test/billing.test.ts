import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import {
  ApiError,
  AuthenticationError,
  HushscriptError,
  NetworkError,
  PaymentMethodRequiredError,
  PermissionDeniedError,
  PreflightError,
} from "../src/errors";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, networkError, stubFetch } from "./helpers";

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
function paths(stub: { requests: Request[] }): string[] {
  return stub.requests.map((request) => new URL(request.url).pathname);
}

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
  it("uses the default card, mints one key and returns the purchase, with no request after the charge", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true), card("pm_b")]),
      { status: 200, body: { status: "ok", balance_seconds: 20_000 } },
    ]);
    const purchase = await client().buy("300min");
    const [body] = purchaseBodies(stub);
    expect(body).toMatchObject({
      pack: "300min",
      quick_payment_method_id: "pm_a",
      policy_ack: false,
    });
    expect(body?.["idempotency_key"]).toMatch(/^[\da-f-]{36}$/);
    expect(purchase).toEqual({ seconds: 20_000, minutes: 333 });
    expect(paths(stub)).toEqual(["/v1/billing/cards", "/v1/billing/purchase"]);
  });

  it("uses the only eligible card when there is no default", async () => {
    const stub = stubFetch([cards(null, [card("pm_old", false), card("pm_ok")]), PURCHASED]);
    await client().buy("45min");
    expect(purchaseBodies(stub)[0]).toMatchObject({ quick_payment_method_id: "pm_ok" });
  });

  it.each([
    ["no card at all", cards(null, [])],
    ["only a card that cannot be charged off-session", cards(null, [card("pm_x", false)])],
  ])("raises PaymentMethodRequiredError and sends no purchase with %s", async (_name, saved) => {
    const stub = stubFetch([saved]);
    const error: unknown = await client()
      .buy("300min")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentMethodRequiredError);
    expect(error).toMatchObject({ code: "no_default_card" });
    expect((error as PaymentMethodRequiredError).hint).toContain("add-card link");
    expect(purchaseBodies(stub)).toEqual([]);
    expect(stub.calls).toBe(1);
  });

  it("asks for a default card, not a new one, when several cards could be charged", async () => {
    const stub = stubFetch([cards(null, [card("pm_1"), card("pm_2")])]);
    const error: unknown = await client()
      .buy("300min")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentMethodRequiredError);
    expect(error).toMatchObject({ code: "default_card_required" });
    expect((error as PaymentMethodRequiredError).hint).toContain("Set a default card");
    expect((error as PaymentMethodRequiredError).hint).not.toContain("No saved card");
    expect(purchaseBodies(stub)).toEqual([]);
    expect(stub.calls).toBe(1);
  });

  it("sends policy_ack true only when the caller acknowledges the no-refund notice", async () => {
    const stub = stubFetch([
      (request) => {
        const path = new URL(request.url).pathname;
        const answer =
          path === "/v1/billing/cards" ? cards("pm_a", [card("pm_a", true, true)]) : PURCHASED;
        return Response.json(answer.body, { status: answer.status });
      },
    ]);
    await client().buy("300min", { acknowledgeNoRefund: true });
    await client().buy("300min", { acknowledgeNoRefund: false });
    await client().buy("300min");
    expect(purchaseBodies(stub).map((body) => body["policy_ack"])).toEqual([true, false, false]);
  });

  it("sends a caller's idempotency key as it is, and refuses a malformed one before any request", async () => {
    const stub = stubFetch([cards("pm_a", [card("pm_a", true, true)]), PURCHASED]);
    await client().buy("300min", { idempotencyKey: "order_42-retry" });
    expect(purchaseBodies(stub)[0]).toMatchObject({ idempotency_key: "order_42-retry" });
    for (const key of ["", "has space", "a".repeat(129), "ünï"]) {
      const invalid = stubFetch([]);
      const error: unknown = await client()
        .buy("300min", { idempotencyKey: key })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(invalid.requests).toHaveLength(0);
    }
  });

  it.each([[null], [42], [{}], [[]]])(
    "refuses a nonstring purchase key %j before any request",
    async (key) => {
      const stub = stubFetch([]);
      const error: unknown = await client()
        .buy("300min", { idempotencyKey: key as unknown as string })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null, idempotencyKey: null });
      expect(stub.requests).toHaveLength(0);
    },
  );

  it.each(["a", "a".repeat(128)])("accepts the purchase key boundary %s", async (key) => {
    const stub = stubFetch([cards("pm_a", [card("pm_a")]), PURCHASED]);
    expect(await client().buy("300min", { idempotencyKey: key })).toEqual({
      seconds: 18000,
      minutes: 300,
    });
    expect(purchaseBodies(stub)[0]?.["idempotency_key"]).toBe(key);
  });

  it("carries the sent purchase key on a 401 without retrying", async () => {
    const key = "purchase-401";
    const stub = stubFetch([
      cards("pm_a", [card("pm_a")]),
      { status: 401, body: { error: "unauthorized", code: 2000 } },
    ]);
    const error: unknown = await client()
      .buy("300min", { idempotencyKey: key })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "unauthorized", status: 401, idempotencyKey: key });
    expect(purchaseBodies(stub).map((body) => body["idempotency_key"])).toEqual([key]);
    expect(paths(stub)).toEqual(["/v1/billing/cards", "/v1/billing/purchase"]);
  });

  it("retries one 502 on the purchase with the same key and charges once", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true)]),
      { status: 502, text: "bad gateway" },
      PURCHASED,
    ]);
    const purchase = await client().buy("300min");
    const bodies = purchaseBodies(stub);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.["idempotency_key"]).toBe(bodies[0]?.["idempotency_key"]);
    expect(purchase.seconds).toBe(18_000);
    expect(paths(stub)).not.toContain("/v1/account");
  });

  it("does not retry a refusal, the error says to buy in the app and carries the key", async () => {
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
    expect((error as HushscriptError).idempotencyKey).toBe(
      purchaseBodies(stub)[0]?.["idempotency_key"],
    );
  });

  it("gives up after a lost connection with the key, and the same key retries without a second charge", async () => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a", true, true)]),
      { error: networkError("ECONNRESET") },
      { error: networkError("ECONNRESET") },
      cards("pm_a", [card("pm_a", true, true)]),
      PURCHASED,
    ]);
    const hs = client();
    const error: unknown = await hs.buy("300min").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    const key = (error as NetworkError).idempotencyKey;
    expect(key).toMatch(/^[\da-f-]{36}$/);
    expect(purchaseBodies(stub).map((body) => body["idempotency_key"])).toEqual([key, key]);
    await hs.buy("300min", { idempotencyKey: key ?? undefined });
    expect(purchaseBodies(stub)[2]?.["idempotency_key"]).toBe(key);
  });

  it.each([
    [9007199254740991, 150119987579016],
    [-9007199254740991, -150119987579016],
    [0, 0],
  ])("accepts safe purchase balance boundary %s", async (seconds, minutes) => {
    const stub = stubFetch([
      cards("pm_a", [card("pm_a")]),
      { status: 200, body: { status: "ok", balance_seconds: seconds } },
    ]);
    expect(await client().buy("300min")).toEqual({ seconds, minutes });
    expect(paths(stub)).toEqual(["/v1/billing/cards", "/v1/billing/purchase"]);
  });

  it.each([
    ["an empty body", { status: 200, text: "" }],
    ["a body that is not JSON", { status: 200, text: "<html>ok</html>" }],
    ["a JSON array", { status: 200, text: "[]" }],
    ["a status that is not ok", { status: 200, body: { status: "pending", balance_seconds: 1 } }],
    [
      "an unsafe balance",
      { status: 200, body: { status: "ok", balance_seconds: 9007199254740992 } },
    ],
    ["a balance above int64", { status: 200, body: { status: "ok", balance_seconds: 1e20 } }],
    ["a balance below int64", { status: 200, body: { status: "ok", balance_seconds: -1e20 } }],
    ["no balance", { status: 200, body: { status: "ok" } }],
    [
      "a balance that is not a whole number",
      { status: 200, body: { status: "ok", balance_seconds: 1.5 } },
    ],
    [
      "a balance that is a string",
      { status: 200, body: { status: "ok", balance_seconds: "18000" } },
    ],
  ])(
    "raises ApiError bad_response, with the key and no follow-up request, for %s",
    async (_name, answer) => {
      const stub = stubFetch([cards("pm_a", [card("pm_a", true, true)]), answer]);
      const error: unknown = await client()
        .buy("300min")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: "bad_response", status: 200, numericCode: null });
      expect((error as HushscriptError).idempotencyKey).toBe(
        purchaseBodies(stub)[0]?.["idempotency_key"],
      );
      expect(paths(stub)).toEqual(["/v1/billing/cards", "/v1/billing/purchase"]);
    },
  );

  it("delegates hs.buy arguments and its result to hs.billing.buy", async () => {
    const hs = client();
    const purchase = { seconds: 123, minutes: 2 };
    const buy = vi.spyOn(hs.billing, "buy").mockResolvedValue(purchase);
    const options = { acknowledgeNoRefund: true, idempotencyKey: "alias-key" };
    expect(await hs.buy("45min", options)).toBe(purchase);
    expect(buy).toHaveBeenCalledExactlyOnceWith("45min", options);
  });

  it("does not catch an error from reading the cards", async () => {
    stubFetch([{ status: 401, body: { error: "unauthorized", code: 2000 } }]);
    const error: unknown = await client()
      .buy("300min")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as HushscriptError).idempotencyKey).toBeNull();
  });
});

describe("billing reads", () => {
  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "<html></html>"],
  ])("raise ApiError bad_response, not a plain error, for %s on a 2xx", async (_name, text) => {
    stubFetch([{ status: 200, text }]);
    const hs = client();
    for (const read of [
      () => hs.billing.packs(),
      () => hs.billing.cards(),
      () => hs.billing.addCardUrl(),
    ]) {
      const error: unknown = await read().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: "bad_response" });
    }
  });

  it("raises ApiError bad_response when setting the default card gets a body that is not JSON", async () => {
    stubFetch([{ status: 200, text: "<html></html>" }]);
    await expect(client().billing.setDefaultCard("pm_a")).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("billing identifiers (R53)", () => {
  const invalidIds = ["", ".", "..", null, 42, {}, undefined, "\uD800", "\uDC00"];

  it.each(invalidIds)("refuses invalid default-card id %j before any request", async (id) => {
    const f = stubFetch([]);
    const error: unknown = await client()
      .billing.setDefaultCard(id as unknown as string)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "invalid_option", status: null });
    expect(f.requests).toHaveLength(0);
  });

  it.each(invalidIds)("refuses invalid purchase pack id %j before any request", async (id) => {
    const f = stubFetch([]);
    const hs = client();
    for (const run of [
      () => hs.buy(id as unknown as string),
      () => hs.billing.buy(id as unknown as string),
    ]) {
      const error: unknown = await run().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(f.requests).toHaveLength(0);
    }
  });
});
