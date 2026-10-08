import { randomUUID } from "node:crypto";
import type { Client } from "openapi-fetch";
import { camelizeKnown, unknownFields } from "../camel.ts";
import { PaymentMethodRequiredError, asHushscriptError, wasNotSent } from "../errors.ts";
import type { components, paths } from "../generated/schema";
import { toMoney, type Money } from "../money.ts";
import { nextCursorOf, paginate } from "../paginate.ts";
import {
  CARDS,
  HOLDS,
  LEDGER,
  PACKS,
  SET_DEFAULT_CARD,
  SETUP_SESSION,
  TRANSACTIONS,
} from "../shapes.ts";
import { badResponse, readBody, readObject } from "../transcribe/common.ts";
import { checkPathId, invalidOption } from "../transcribe/preflight.ts";

/** A minute pack as the account can see it. A field the API adds later is kept on the object at run time, camelCased. */
export interface Pack {
  /** `45min`, `300min`, `900min`, `1800min` or `6000min`. */
  id: string;
  seconds: number;
  /** `seconds / 60` rounded toward zero. */
  minutes: number;
  /** The price in the account's own currency, as the API states it. */
  price: Money;
  /** Extra minutes an available referral bonus would add to this purchase; 0 when none. */
  bonusMinutes: number;
  /** False only for an agent account's tier-locked pack. */
  available: boolean;
}

/** A saved payment method. A field the API adds later is kept on the object at run time, camelCased. */
export interface Card {
  id: string;
  type: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  email: string | null;
  isDefault: boolean;
  /** Whether `buy()` may charge it without the buyer present. */
  fastCheckoutEligible: boolean;
}

/** The saved payment methods. A field the API adds later is kept on the object at run time, camelCased. */
export interface Cards {
  defaultId: string | null;
  cards: Card[];
}

/** One purchase, as the API reports it (keys camelCased, timestamps as dates). A field the API adds later is kept on the object at run time, camelCased. */
export interface Transaction {
  id: number;
  seconds: number;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  paymentMethodType: string | null;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  /** The public receipt reference. */
  receiptNumber: string | null;
  initiatedVia: string | null;
}

/** One movement of the credit balance. A field the API adds later is kept on the object at run time, camelCased. */
export interface LedgerEntry {
  id: number;
  deltaSeconds: number;
  kind: string;
  jobId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Seconds reserved by work still running; already deducted from the balance. A field the API adds later is kept on the object at run time, camelCased. */
export interface Hold {
  id: string;
  kind: "transcription" | "translation" | "insights" | "qa";
  seconds: number;
  createdAt: Date;
}

/** What a purchase left the account with, from the purchase answer alone. A field the API adds later is kept on the object at run time, camelCased. */
export interface Purchase {
  /** The balance after the purchase settled: spendable seconds, holds already deducted. */
  seconds: number;
  /** `seconds / 60` rounded toward zero. */
  minutes: number;
}

export interface BuyOptions {
  /** Records that the no-refund, instant-delivery notice was shown to the buyer. It never gates the charge. */
  acknowledgeNoRefund?: boolean | undefined;
  /** 1 to 128 of `A-Za-z0-9_-`. Left out, a fresh key is minted for the call. */
  idempotencyKey?: string | undefined;
}

const PURCHASE_KEY = /^[\w-]{1,128}$/;
const PURCHASE_ROUTE = "POST /v1/billing/purchase";

function date(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

const PACK_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "id",
    "amount",
    "currency",
    "seconds",
    "referral_bonus_seconds",
    "available",
  ] satisfies (keyof components["schemas"]["Pack"])[]),
]);
const CARD_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "id",
    "type",
    "brand",
    "last4",
    "exp_month",
    "exp_year",
    "email",
    "is_default",
    "fast_checkout_eligible",
  ] satisfies (keyof components["schemas"]["Card"])[]),
]);
const TRANSACTION_FIELDS: ReadonlySet<string> = new Set([
  ...([
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
  ] satisfies (keyof components["schemas"]["TransactionsResponse"]["transactions"][number])[]),
]);
const LEDGER_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "id",
    "delta_seconds",
    "kind",
    "job_id",
    "note",
    "created_at",
  ] satisfies (keyof components["schemas"]["CreditLedgerResponse"]["entries"][number])[]),
]);
const HOLD_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "id",
    "kind",
    "seconds",
    "created_at",
  ] satisfies (keyof components["schemas"]["HoldsResponse"]["holds"][number])[]),
]);
const CARDS_FIELDS: ReadonlySet<string> = new Set(["default_id", "methods"]);
const PURCHASE_FIELDS: ReadonlySet<string> = new Set(["status", "balance_seconds"]);

function packOf(raw: components["schemas"]["Pack"]): Pack {
  return {
    ...unknownFields(raw, PACK_FIELDS),
    id: raw.id,
    seconds: raw.seconds,
    minutes: Math.trunc(raw.seconds / 60),
    price: toMoney(raw.amount, raw.currency),
    bonusMinutes: Math.trunc(raw.referral_bonus_seconds / 60),
    available: raw.available ?? true,
  };
}

/** The card `buy()` charges: the default, else the only one that can be charged. */
function chosenCard(saved: Cards): string {
  if (saved.defaultId !== null) return saved.defaultId;
  const eligible = saved.cards.filter((card) => card.fastCheckoutEligible);
  const [only] = eligible;
  if (only === undefined) {
    throw new PaymentMethodRequiredError({
      message: "The account has no saved card that can be charged.",
    });
  }
  if (eligible.length > 1) {
    throw new PaymentMethodRequiredError({
      code: "default_card_required",
      message: "The account has no default card and several that can be charged.",
    });
  }
  return only.id;
}

export class BillingResource {
  readonly #api: Client<paths>;

  constructor(api: Client<paths>) {
    this.#api = api;
  }

  /** The minute packs this account can buy, priced in its own currency. Needs the `billing` scope. */
  async packs(): Promise<Pack[]> {
    const body = await readBody<components["schemas"]["PacksResponse"]>(
      this.#api.GET("/v1/billing/packs", { parseAs: "text" }),
      "GET /v1/billing/packs",
      PACKS,
    );
    return body.packs.map(packOf);
  }

  async cards(): Promise<Cards> {
    const body = await readBody<components["schemas"]["CardsResponse"]>(
      this.#api.GET("/v1/billing/cards", { parseAs: "text" }),
      "GET /v1/billing/cards",
      CARDS,
    );
    return {
      ...unknownFields(body, CARDS_FIELDS),
      defaultId: body.default_id,
      cards: body.methods.map((m) => camelizeKnown(m, CARD_FIELDS) as unknown as Card),
    };
  }

  async setDefaultCard(cardId: string): Promise<void> {
    checkPathId(cardId, "cardId");
    await readBody(
      this.#api.POST("/v1/billing/cards/default", {
        body: { payment_method_id: cardId },
        parseAs: "text",
      }),
      "POST /v1/billing/cards/default",
      SET_DEFAULT_CARD,
    );
  }

  /**
   * The hosted page where a card is saved; open it in a browser. The request carries a key, so
   * the single retry after a 502 lands on the same page.
   */
  async addCardUrl(): Promise<string> {
    const body = await readBody<components["schemas"]["SetupSessionResponse"]>(
      this.#api.POST("/v1/billing/setup-session", {
        body: { idempotency_key: randomUUID() },
        parseAs: "text",
      }),
      "POST /v1/billing/setup-session",
      SETUP_SESSION,
    );
    return body.checkout_url;
  }

  /**
   * Buys `packId` with the default card and returns the balance the purchase answer reports. It
   * makes no request after the charge, so nothing can fail once the money has moved. Every error
   * raised once the purchase request may have been sent carries `idempotencyKey`; pass it back as
   * `idempotencyKey` to retry without any chance of a second charge. One raised before any attempt
   * was sent carries none: nothing can have been charged.
   */
  async buy(packId: string, options: BuyOptions = {}): Promise<Purchase> {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- null is invalid and must not select a generated key.
    const key = options.idempotencyKey === undefined ? randomUUID() : options.idempotencyKey;
    if (typeof key !== "string" || !PURCHASE_KEY.test(key)) {
      throw invalidOption(
        "idempotencyKey must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.",
      );
    }
    const card = chosenCard(await this.cards());
    try {
      const { status, body } = await readObject(
        this.#api.POST("/v1/billing/purchase", {
          body: {
            pack: packId,
            idempotency_key: key,
            quick_payment_method_id: card,
            policy_ack: options.acknowledgeNoRefund === true,
          },
          parseAs: "text",
        }),
        PURCHASE_ROUTE,
      );
      const seconds = body?.["balance_seconds"];
      if (
        body?.["status"] !== "ok" ||
        typeof seconds !== "number" ||
        !Number.isSafeInteger(seconds)
      ) {
        throw badResponse(PURCHASE_ROUTE, status);
      }
      return {
        ...unknownFields(body, PURCHASE_FIELDS),
        seconds,
        minutes: Math.trunc(seconds / 60) + 0,
      };
    } catch (error) {
      const failure = asHushscriptError(error);
      if (!wasNotSent(failure)) failure.idempotencyKey = key;
      throw failure;
    }
  }

  /** Purchases, newest first. */
  transactions(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<Transaction> {
    return paginate(async (cursor) => {
      const page = await readBody<components["schemas"]["TransactionsResponse"]>(
        this.#api.GET("/v1/billing/transactions", {
          params: { query: cursor === null ? {} : { cursor } },
          parseAs: "text",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        "GET /v1/billing/transactions",
        TRANSACTIONS,
      );
      return {
        items: page.transactions.map(
          (row) =>
            ({
              ...(camelizeKnown(row, TRANSACTION_FIELDS) as unknown as Transaction),
              createdAt: date(row.created_at),
            }) satisfies Transaction,
        ),
        nextCursor: nextCursorOf(page.next_cursor),
      };
    }, options.signal);
  }

  /** Every hold, settle, release, purchase and refund that moved the balance, newest first. */
  ledger(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<LedgerEntry> {
    return paginate(async (cursor) => {
      const page = await readBody<components["schemas"]["CreditLedgerResponse"]>(
        this.#api.GET("/v1/billing/ledger", {
          params: { query: cursor === null ? {} : { cursor } },
          parseAs: "text",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        "GET /v1/billing/ledger",
        LEDGER,
      );
      return {
        items: page.entries.map(
          (row) =>
            ({
              ...(camelizeKnown(row, LEDGER_FIELDS) as unknown as LedgerEntry),
              createdAt: date(row.created_at),
            }) satisfies LedgerEntry,
        ),
        nextCursor: nextCursorOf(page.next_cursor),
      };
    }, options.signal);
  }

  /** The seconds currently reserved by work in flight, newest first. */
  holds(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<Hold> {
    return paginate(async (cursor) => {
      const page = await readBody<components["schemas"]["HoldsResponse"]>(
        this.#api.GET("/v1/billing/holds", {
          params: { query: cursor === null ? {} : { cursor } },
          parseAs: "text",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        "GET /v1/billing/holds",
        HOLDS,
      );
      return {
        items: page.holds.map(
          (row) =>
            ({
              ...(camelizeKnown(row, HOLD_FIELDS) as unknown as Hold),
              createdAt: date(row.created_at),
            }) satisfies Hold,
        ),
        nextCursor: nextCursorOf(page.next_cursor),
      };
    }, options.signal);
  }
}
