import { randomUUID } from "node:crypto";
import type { Client } from "openapi-fetch";
import { camelize } from "../camel.ts";
import { PaymentMethodRequiredError } from "../errors.ts";
import type { components, paths } from "../generated/schema";
import { toMoney, type Money } from "../money.ts";
import { paginate } from "../paginate.ts";
import { present } from "../transcribe/common.ts";
import { invalidOption } from "../transcribe/preflight.ts";
import { readAccount, toBalance, type Balance } from "./account.ts";

/** A minute pack as the account can see it (spec 6.5). */
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

/** A saved payment method. */
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

export interface Cards {
  defaultId: string | null;
  cards: Card[];
}

/** One purchase, as the API reports it (keys camelCased, timestamps as dates). */
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

/** One movement of the credit balance. */
export interface LedgerEntry {
  id: number;
  deltaSeconds: number;
  kind: string;
  jobId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Seconds reserved by work still running; already deducted from the balance. */
export interface Hold {
  id: string;
  kind: "transcription" | "translation" | "insights" | "qa";
  seconds: number;
  createdAt: Date;
}

export interface BuyOptions {
  /** Records that the no-refund, instant-delivery notice was shown to the buyer. It never gates the charge. */
  acknowledgeNoRefund?: boolean | undefined;
  /** 1 to 128 of `A-Za-z0-9_-`. Left out, a fresh key is minted for the call. */
  idempotencyKey?: string | undefined;
}

const PURCHASE_KEY = /^[\w-]{1,128}$/;

function date(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

function packOf(raw: components["schemas"]["Pack"]): Pack {
  return {
    id: raw.id,
    seconds: raw.seconds,
    minutes: Math.trunc(raw.seconds / 60),
    price: toMoney(raw.amount, raw.currency),
    bonusMinutes: Math.trunc(raw.referral_bonus_seconds / 60),
    available: raw.available ?? true,
  };
}

/** The card `buy()` charges: the default, else the only one that can be charged (spec 6.5). */
function chosenCard(saved: Cards): string {
  if (saved.defaultId !== null) return saved.defaultId;
  const eligible = saved.cards.filter((card) => card.fastCheckoutEligible);
  const [only] = eligible;
  if (only === undefined || eligible.length !== 1) {
    throw new PaymentMethodRequiredError({
      message:
        eligible.length === 0
          ? "The account has no saved card that can be charged."
          : "The account has no default card and several that can be charged.",
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
    const { data } = await this.#api.GET("/v1/billing/packs");
    return present(data, "GET /v1/billing/packs").packs.map(packOf);
  }

  async cards(): Promise<Cards> {
    const { data } = await this.#api.GET("/v1/billing/cards");
    const body = present(data, "GET /v1/billing/cards");
    return { defaultId: body.default_id, cards: body.methods.map((m) => camelize(m) as Card) };
  }

  async setDefaultCard(cardId: string): Promise<void> {
    await this.#api.POST("/v1/billing/cards/default", { body: { payment_method_id: cardId } });
  }

  /**
   * The hosted page where a card is saved; open it in a browser. The request carries a key, so
   * the single retry after a 502 lands on the same page.
   */
  async addCardUrl(): Promise<string> {
    const { data } = await this.#api.POST("/v1/billing/setup-session", {
      body: { idempotency_key: randomUUID() },
    });
    return present(data, "POST /v1/billing/setup-session").checkout_url;
  }

  /** Buys `packId` with the default card (spec 6.5) and returns the new balance. */
  async buy(packId: string, options: BuyOptions = {}): Promise<Balance> {
    const key = options.idempotencyKey ?? randomUUID();
    if (!PURCHASE_KEY.test(key)) {
      throw invalidOption(
        "idempotencyKey must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.",
      );
    }
    const card = chosenCard(await this.cards());
    const { data } = await this.#api.POST("/v1/billing/purchase", {
      body: {
        pack: packId,
        idempotency_key: key,
        quick_payment_method_id: card,
        policy_ack: options.acknowledgeNoRefund === true,
      },
    });
    const purchased = present(data, "POST /v1/billing/purchase");
    const account = await readAccount(this.#api);
    return toBalance({ ...account, balance_seconds: purchased.balance_seconds });
  }

  /** Purchases, newest first. */
  transactions(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<Transaction> {
    return paginate(async (cursor) => {
      const { data } = await this.#api.GET("/v1/billing/transactions", {
        params: { query: cursor === null ? {} : { cursor } },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const page = present(data, "GET /v1/billing/transactions");
      return {
        items: page.transactions.map(
          (row) =>
            ({
              ...(camelize(row) as Transaction),
              createdAt: date(row.created_at),
            }) satisfies Transaction,
        ),
        nextCursor: page.next_cursor,
      };
    }, options.signal);
  }

  /** Every hold, settle, release, purchase and refund that moved the balance, newest first. */
  ledger(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<LedgerEntry> {
    return paginate(async (cursor) => {
      const { data } = await this.#api.GET("/v1/billing/ledger", {
        params: { query: cursor === null ? {} : { cursor } },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const page = present(data, "GET /v1/billing/ledger");
      return {
        items: page.entries.map(
          (row) =>
            ({
              ...(camelize(row) as LedgerEntry),
              createdAt: date(row.created_at),
            }) satisfies LedgerEntry,
        ),
        nextCursor: page.next_cursor,
      };
    }, options.signal);
  }

  /** The seconds currently reserved by work in flight, newest first. */
  holds(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<Hold> {
    return paginate(async (cursor) => {
      const { data } = await this.#api.GET("/v1/billing/holds", {
        params: { query: cursor === null ? {} : { cursor } },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const page = present(data, "GET /v1/billing/holds");
      return {
        items: page.holds.map(
          (row) => ({ ...(camelize(row) as Hold), createdAt: date(row.created_at) }) satisfies Hold,
        ),
        nextCursor: page.next_cursor,
      };
    }, options.signal);
  }
}
