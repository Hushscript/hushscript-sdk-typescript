import { describe, expect, it } from "vitest";
import { toMoney } from "../src/money";

const NBSP = " ";

describe("toMoney", () => {
  it.each([
    [599, "USD", "$5.99"],
    [1, "USD", "$0.01"],
    [0, "USD", "$0.00"],
    [150_000, "USD", "$1,500.00"],
    [500, "JPY", "¥500"],
    [1500, "KWD", `KWD${NBSP}1.500`],
    [3499, "EUR", "€34.99"],
    // Stripe counts two minor digits where Intl counts none: the price is 100x smaller than Intl's.
    [1_500_000, "IDR", `IDR${NBSP}15,000.00`],
    [150_000, "HUF", `HUF${NBSP}1,500.00`],
    [150_000, "ISK", `ISK${NBSP}1,500.00`],
    [150_000, "COP", `COP${NBSP}1,500.00`],
    // ... and two where Intl counts three.
    [1500, "LYD", `LYD${NBSP}15.00`],
    [1500, "BHD", `BHD${NBSP}1.500`],
    [250, "usd", "$2.50"],
  ])("shows %s %s as %s, using Stripe's minor-unit digits", (amount, currency, shown) => {
    expect(toMoney(amount, currency)).toEqual({ amount, currency, formatted: shown });
  });

  it.each([
    ["BIF", "BIF 1,500"],
    ["CLP", "CLP 1,500"],
    ["DJF", "DJF 1,500"],
    ["GNF", "GNF 1,500"],
    ["JPY", "¥1,500"],
    ["KMF", "KMF 1,500"],
    ["KRW", "₩1,500"],
    ["MGA", "MGA 1,500"],
    ["PYG", "PYG 1,500"],
    ["RWF", "RWF 1,500"],
    ["UGX", "UGX 1,500"],
    ["VND", "₫1,500"],
    ["VUV", "VUV 1,500"],
    ["XAF", "FCFA 1,500"],
    ["XOF", "F CFA 1,500"],
    ["XPF", "CFPF 1,500"],
    ["BHD", "BHD 1.500"],
    ["JOD", "JOD 1.500"],
    ["KWD", "KWD 1.500"],
    ["OMR", "OMR 1.500"],
    ["TND", "TND 1.500"],
  ])("pins the complete spec 6.5 minor-unit table for %s", (currency, formatted) => {
    expect(toMoney(1500, currency)).toEqual({ amount: 1500, currency, formatted });
  });

  it("always shows the currency's full digits, never fewer", () => {
    expect(toMoney(500, "USD").formatted).toBe("$5.00");
    expect(toMoney(1000, "KWD").formatted).toBe(`KWD${NBSP}1.000`);
  });

  it.each(["ZZZ", "ZZZZ", "", "us", "x1"])(
    "shows an unknown currency %j as a plain amount and code, never throwing",
    (currency) => {
      expect(toMoney(599, currency)).toEqual({
        amount: 599,
        currency,
        formatted: `5.99 ${currency.toUpperCase()}`,
      });
    },
  );
});
