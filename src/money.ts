/** A price as the API states it, with a display string in the `en` locale. */
export interface Money {
  /** Minor units of `currency`, from the API. */
  amount: number;
  /** ISO 4217 code, from the API. */
  currency: string;
  /** For example `$5.99`. */
  formatted: string;
}

// Stripe's minor-unit digits, which the API's amounts use. Intl's own table disagrees for some
// currencies (IDR, HUF, ISK and others), which would make a price 100 times too large or small.
const NO_MINOR_UNITS: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_MINOR_UNITS: ReadonlySet<string> = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

function minorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (NO_MINOR_UNITS.has(code)) return 0;
  return THREE_MINOR_UNITS.has(code) ? 3 : 2;
}

export function toMoney(amount: number, currency: string): Money {
  const digits = minorUnitDigits(currency);
  const format = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return { amount, currency, formatted: format.format(amount / 10 ** digits) };
}
