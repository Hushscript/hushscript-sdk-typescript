import type { Client } from "openapi-fetch";
import type { components, paths } from "../generated/schema";
import { present } from "../transcribe/common.ts";

/** The full `GET /v1/account` body: limits, `card_on_file`, `data_region` and the balance. */
export type Account = components["schemas"]["AccountResponse"];

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

/** Builds the balance from an account body; `purchases_remaining_in_window` is not in the OpenAPI schema yet, so it is read untyped. */
export function toBalance(account: Account): Balance {
  const remaining = (account as Record<string, unknown>)["purchases_remaining_in_window"];
  return {
    seconds: account.balance_seconds,
    // `+ 0` turns the -0 that truncating -59 / 60 gives into 0.
    minutes: Math.trunc(account.balance_seconds / 60) + 0,
    heldSeconds: account.held_seconds,
    expiresAt:
      account.credits_expire_at === null ? null : new Date(account.credits_expire_at * 1000),
    purchasesRemaining: typeof remaining === "number" ? remaining : null,
  };
}

export async function readAccount(api: Client<paths>): Promise<Account> {
  const { data } = await api.GET("/v1/account");
  return present(data, "GET /v1/account");
}
