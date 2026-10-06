import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { PermissionDeniedError } from "../src/errors";
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

function account(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    balance_seconds: 18_000,
    held_seconds: 600,
    credits_expire_at: null,
    card_on_file: true,
    data_region: "eu",
    limits: { max_daily_seconds: 36_000 },
    ...extra,
  };
}

describe("hs.balance", () => {
  it.each([
    [-90, -1],
    [-60, -1],
    [-59, 0],
    [0, 0],
    [59, 0],
    [90, 1],
    [18_000, 300],
  ])("shows %s seconds as %s minutes, rounding toward zero", async (seconds, minutes) => {
    stubFetch([{ status: 200, body: account({ balance_seconds: seconds }) }]);
    const balance = await client().balance();
    expect(balance.seconds).toBe(seconds);
    expect(balance.minutes).toBe(minutes);
  });

  it("reports held seconds and the expiry as a Date", async () => {
    stubFetch([{ status: 200, body: account({ credits_expire_at: 1_760_000_000 }) }]);
    const balance = await client().balance();
    expect(balance.heldSeconds).toBe(600);
    expect(balance.expiresAt).toEqual(new Date(1_760_000_000_000));
  });

  it("has no expiry when none is armed", async () => {
    stubFetch([{ status: 200, body: account() }]);
    expect((await client().balance()).expiresAt).toBeNull();
  });

  it("reads purchases_remaining_in_window untyped, and is null when it is absent or not a number", async () => {
    stubFetch([{ status: 200, body: account({ purchases_remaining_in_window: 2 }) }]);
    expect((await client().balance()).purchasesRemaining).toBe(2);
    stubFetch([{ status: 200, body: account() }]);
    expect((await client().balance()).purchasesRemaining).toBeNull();
    stubFetch([{ status: 200, body: account({ purchases_remaining_in_window: "2" }) }]);
    expect((await client().balance()).purchasesRemaining).toBeNull();
  });

  it("sends GET /v1/account with the bearer token and raises typed errors", async () => {
    const f = stubFetch([{ status: 403, body: { error: "pat_scope_missing", code: 2023 } }]);
    await expect(client().balance()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(f.requests[0]?.url).toBe(`${BASE}/v1/account`);
    expect(f.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("hs.account", () => {
  it("returns the full account body", async () => {
    const body = account({ purchases_remaining_in_window: 3 });
    stubFetch([{ status: 200, body }]);
    expect(await client().account()).toEqual(body);
  });
});
