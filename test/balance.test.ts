import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { PermissionDeniedError } from "../src/errors";
import { BASE, LIMITS, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch } from "./helpers";

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
    limits: LIMITS,
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

  it.each([null, "2", -1, 0.5, 1e20])(
    "treats invalid optional purchases remaining %j as absent",
    async (remaining) => {
      for (const read of [() => client().balance(), () => client().account()]) {
        stubFetch([{ status: 200, body: account({ purchases_remaining_in_window: remaining }) }]);
        const result = await read();
        expect(
          "purchasesRemaining" in result
            ? result.purchasesRemaining
            : result.purchasesRemainingInWindow,
        ).toBeNull();
      }
    },
  );

  it("treats an overflowing optional purchases count as absent", async () => {
    for (const read of [() => client().balance(), () => client().account()]) {
      stubFetch([
        {
          status: 200,
          text: JSON.stringify(account()).replace(
            '"balance_seconds":18000',
            '"purchases_remaining_in_window":1e400,"balance_seconds":18000',
          ),
        },
      ]);
      const result = await read();
      expect(
        "purchasesRemaining" in result
          ? result.purchasesRemaining
          : result.purchasesRemainingInWindow,
      ).toBeNull();
    }
  });

  it.each([0, 3])("accepts optional purchases remaining %s", async (remaining) => {
    stubFetch([{ status: 200, body: account({ purchases_remaining_in_window: remaining }) }]);
    expect((await client().balance()).purchasesRemaining).toBe(remaining);
    stubFetch([{ status: 200, body: account({ purchases_remaining_in_window: remaining }) }]);
    expect((await client().account()).purchasesRemainingInWindow).toBe(remaining);
  });

  it("sends GET /v1/account with the bearer token and raises typed errors", async () => {
    const f = stubFetch([{ status: 403, body: { error: "pat_scope_missing", code: 2023 } }]);
    await expect(client().balance()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(f.requests[0]?.url).toBe(`${BASE}/v1/account`);
    expect(f.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("hs.account", () => {
  it("returns the camelCase account with Date expiry and camelCased limits", async () => {
    stubFetch([
      {
        status: 200,
        body: account({
          credits_expire_at: 1_760_000_000,
          purchases_remaining_in_window: 3,
          limits: {
            max_daily_seconds: 36_000,
            max_active_jobs: 3,
            active_jobs: 1,
            used_today_seconds: 120,
          },
        }),
      },
    ]);
    expect(await client().account()).toEqual({
      balanceSeconds: 18_000,
      heldSeconds: 600,
      creditsExpireAt: new Date(1_760_000_000_000),
      cardOnFile: true,
      dataRegion: "eu",
      limits: { maxDailySeconds: 36_000, maxActiveJobs: 3, activeJobs: 1, usedTodaySeconds: 120 },
      purchasesRemainingInWindow: 3,
    });
  });

  it("has a null expiry and null purchasesRemainingInWindow when the API sends neither", async () => {
    stubFetch([{ status: 200, body: account() }]);
    const result = await client().account();
    expect(result.creditsExpireAt).toBeNull();
    expect(result.purchasesRemainingInWindow).toBeNull();
    expect(result.limits).toEqual({
      maxDailySeconds: 36_000,
      maxActiveJobs: 50,
      activeJobs: 0,
      usedTodaySeconds: 0,
    });
    expect(Object.keys(result).some((key) => key.includes("_"))).toBe(false);
  });
});
