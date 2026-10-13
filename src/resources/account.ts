import type { Client } from "openapi-fetch";
import type { components, paths } from "../generated/schema";
import { camelize, unknownFields } from "../camel.ts";
import { ACCOUNT } from "../shapes.ts";
import { readBody } from "../transcribe/common.ts";

/** `GET /v1/account` as the API sends it; `purchases_remaining_in_window` is not in the OpenAPI schema yet. */
export type RawAccount = components["schemas"]["AccountResponse"];

/** The caller's current upload admission limits (the API's `limits` object, camelCased). */
export interface UploadLimits {
  /** The daily transcription cap, in seconds. */
  maxDailySeconds: number;
  /** The most pipeline jobs in flight at once. */
  maxActiveJobs: number;
  /** Pipeline jobs in flight now. */
  activeJobs: number;
  /** Billable seconds used today. */
  usedTodaySeconds: number;
}

/** The account: balance, limits, card and region. A field the API adds later is kept on the object at run time, camelCased. */
export interface Account {
  /** Net of holds and clawback debt; may be negative. */
  balanceSeconds: number;
  /** Committed to in-flight jobs; already deducted from `balanceSeconds`. */
  heldSeconds: number;
  creditsExpireAt: Date | null;
  cardOnFile: boolean;
  /** For example `us`, `eu`, `apac` or `oc`. */
  dataRegion: string;
  limits: UploadLimits;
  /** Agent accounts only, else null. */
  purchasesRemainingInWindow: number | null;
}

/** The balance, with the same run-time extras as `Account`. */
export interface Balance {
  /** Spendable now; may be negative (clawback debt). Holds for in-flight jobs are already deducted. */
  seconds: number;
  /** `seconds / 60` rounded toward zero. */
  minutes: number;
  /** Committed to in-flight jobs; already deducted from `seconds`. */
  heldSeconds: number;
  expiresAt: Date | null;
  /** Agent accounts only, else null. */
  purchasesRemaining: number | null;
}

// Every field the account answer is known to carry; any other is kept on the result, camelized.
const ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "balance_seconds",
    "held_seconds",
    "credits_expire_at",
    "card_on_file",
    "data_region",
    "limits",
  ] satisfies (keyof RawAccount)[]),
  "purchases_remaining_in_window",
]);

function expiry(raw: RawAccount): Date | null {
  return raw.credits_expire_at === null ? null : new Date(raw.credits_expire_at * 1000);
}

function purchasesRemaining(raw: RawAccount): number | null {
  const remaining = (raw as Record<string, unknown>)["purchases_remaining_in_window"];
  return typeof remaining === "number" && Number.isSafeInteger(remaining) && remaining >= 0
    ? remaining
    : null;
}

export function toAccount(raw: RawAccount): Account {
  return {
    ...unknownFields(raw, ACCOUNT_FIELDS),
    balanceSeconds: raw.balance_seconds,
    heldSeconds: raw.held_seconds,
    creditsExpireAt: expiry(raw),
    cardOnFile: raw.card_on_file,
    dataRegion: raw.data_region,
    limits: camelize(raw.limits) as UploadLimits,
    purchasesRemainingInWindow: purchasesRemaining(raw),
  };
}

export function toBalance(raw: RawAccount): Balance {
  return {
    ...unknownFields(raw, ACCOUNT_FIELDS),
    seconds: raw.balance_seconds,
    // `+ 0` turns the -0 that truncating -59 / 60 gives into 0.
    minutes: Math.trunc(raw.balance_seconds / 60) + 0,
    heldSeconds: raw.held_seconds,
    expiresAt: expiry(raw),
    purchasesRemaining: purchasesRemaining(raw),
  };
}

export function readAccount(api: Client<paths>, signal?: AbortSignal): Promise<RawAccount> {
  return readBody<RawAccount>(
    api.GET("/v1/account", { parseAs: "text", ...(signal === undefined ? {} : { signal }) }),
    "GET /v1/account",
    ACCOUNT,
  );
}
