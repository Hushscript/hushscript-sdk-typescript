/** A price as the API states it, with a display string in the `en` locale. */
export interface Money {
  /** Minor units of `currency`, from the API. */
  amount: number;
  /** ISO 4217 code, from the API. */
  currency: string;
  /** For example `$5.99`. */
  formatted: string;
}

export function toMoney(amount: number, currency: string): Money {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return { amount, currency, formatted: format.format(amount / 10 ** digits) };
}
