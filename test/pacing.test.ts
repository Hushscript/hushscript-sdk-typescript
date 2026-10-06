import { describe, expect, it, vi } from "vitest";
import { TokenBucket } from "../src/http/pacing";
import { fakeClock } from "./helpers";

describe("TokenBucket", () => {
  it("lets `capacity` acquisitions through at once", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(4, 60_000, clock);
    for (let i = 0; i < 4; i += 1) expect(await bucket.acquire()).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it("makes the fifth wait until the first leaves the window", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(4, 60_000, clock);
    for (let i = 0; i < 4; i += 1) await bucket.acquire();
    expect(await bucket.acquire()).toBe(60_000);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("counts the time that already passed", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 60_000, clock);
    await bucket.acquire();
    clock.advance(20_000);
    await bucket.acquire();
    expect(await bucket.acquire()).toBe(40_000);
  });

  it("frees slots as the window slides", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 60_000, clock);
    await bucket.acquire();
    await bucket.acquire();
    clock.advance(60_000);
    expect(await bucket.acquire()).toBe(0);
  });

  it("serves concurrent callers one slot at a time", async () => {
    const clock = fakeClock({ manual: true });
    const bucket = new TokenBucket(1, 1000, clock);
    const finished: number[] = [];
    const callers = [0, 1, 2].map((id) =>
      bucket.acquire().then(() => {
        finished.push(id);
      }),
    );
    await vi.waitFor(() => {
      expect(finished).toEqual([0]);
    });
    clock.advance(1000);
    await vi.waitFor(() => {
      expect(finished).toHaveLength(2);
    });
    clock.advance(1000);
    await Promise.all(callers);
    expect(finished).toHaveLength(3);
  });

  it("stops waiting when the signal aborts", async () => {
    const clock = fakeClock({ manual: true });
    const bucket = new TokenBucket(1, 1000, clock);
    await bucket.acquire();
    const controller = new AbortController();
    const pending = bucket.acquire(controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
