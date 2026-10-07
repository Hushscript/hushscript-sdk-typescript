import { describe, expect, it } from "vitest";
import { toMoney } from "../src/money";

describe("toMoney", () => {
  it.each([
    [599, "USD", "$5.99"],
    [1, "USD", "$0.01"],
    [0, "USD", "$0.00"],
    [150_000, "USD", "$1,500.00"],
    [500, "JPY", "¥500"],
    [1500, "KWD", "KWD 1.500"],
    [3499, "EUR", "€34.99"],
  ])("shows %s %s as %s, using the currency's own minor-unit digits", (amount, currency, shown) => {
    const money = toMoney(amount, currency);
    expect(money).toEqual({ amount, currency, formatted: shown.replace(" ", " ") });
  });
});
