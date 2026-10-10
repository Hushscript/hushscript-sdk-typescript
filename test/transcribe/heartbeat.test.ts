import { describe, expect, it } from "vitest";
import { AuthenticationError, ConflictError, NetworkError } from "../../src/errors";
import { runHeartbeat } from "../../src/transcribe/heartbeat";
import { capped, fakeClock } from "../helpers";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("heartbeat loop", () => {
  it("fires every 120 s, measured from the start, and stops with its signal", async () => {
    const clock = fakeClock({ manual: true });
    const stop = new AbortController();
    const stamps: number[] = [];
    const done = runHeartbeat({
      clock,
      signal: stop.signal,
      send: capped("send", 100, () => {
        stamps.push(clock.now());
        return Promise.resolve();
      }),
    });
    for (let tick = 0; tick < 3; tick += 1) {
      await flush();
      clock.advance(120_000);
    }
    await flush();
    expect(stamps).toEqual([120_000, 240_000, 360_000]);
    stop.abort();
    await done;
    expect(clock.pending).toHaveLength(0);
  });

  it("keeps the interval when a heartbeat is slow", async () => {
    const clock = fakeClock({ manual: true });
    const stop = new AbortController();
    const stamps: number[] = [];
    const done = runHeartbeat({
      clock,
      signal: stop.signal,
      send: capped("send", 100, async () => {
        stamps.push(clock.now());
        await new Promise<void>((resolve) => setImmediate(resolve));
        clock.advance(30_000);
      }),
    });
    await flush();
    clock.advance(120_000);
    await flush();
    expect(clock.pending[0]?.at).toBe(240_000);
    stop.abort();
    await done;
    expect(stamps).toEqual([120_000]);
  });

  it("starts again from now after a tick that came more than an interval late", async () => {
    const clock = fakeClock({ manual: true });
    const stop = new AbortController();
    const stamps: number[] = [];
    const done = runHeartbeat({
      clock,
      signal: stop.signal,
      send: capped("send", 100, () => {
        stamps.push(clock.now());
        return Promise.resolve();
      }),
    });
    await flush();
    clock.advance(360_000);
    await flush();
    expect(stamps).toEqual([360_000]);
    expect(clock.pending.map((entry) => entry.at)).toEqual([480_000]);
    stop.abort();
    await done;
  });

  it("returns quietly when unauthorized arrives after its signal aborted", async () => {
    const clock = fakeClock({ manual: true });
    const stop = new AbortController();
    const done = runHeartbeat({
      clock,
      signal: stop.signal,
      send: capped("send", 100, () => {
        stop.abort();
        return Promise.reject(new AuthenticationError({ code: "unauthorized", message: "no" }));
      }),
    });
    await flush();
    clock.advance(120_000);
    await expect(done).resolves.toBeUndefined();
  });

  it("stops quietly on wrong_state", async () => {
    const clock = fakeClock({ manual: true });
    let sent = 0;
    const done = runHeartbeat({
      clock,
      signal: new AbortController().signal,
      send: capped("send", 100, () => {
        sent += 1;
        return Promise.reject(new ConflictError({ code: "wrong_state", message: "moved on" }));
      }),
    });
    await flush();
    clock.advance(120_000);
    await done;
    expect(sent).toBe(1);
  });

  it("raises unauthorized and ignores every other failure", async () => {
    const clock = fakeClock({ manual: true });
    let sent = 0;
    const done = runHeartbeat({
      clock,
      signal: new AbortController().signal,
      send: capped("send", 100, () => {
        sent += 1;
        return sent === 1
          ? Promise.reject(new NetworkError({ message: "down" }))
          : Promise.reject(new AuthenticationError({ code: "unauthorized", message: "no" }));
      }),
    });
    const outcome = done.catch((e: unknown) => e);
    await flush();
    clock.advance(120_000);
    await flush();
    clock.advance(120_000);
    expect(await outcome).toBeInstanceOf(AuthenticationError);
    expect(sent).toBe(2);
  });

  it("returns when aborted during a send", async () => {
    const clock = fakeClock({ manual: true });
    const stop = new AbortController();
    const done = runHeartbeat({
      clock,
      signal: stop.signal,
      send: capped("send", 100, () => {
        stop.abort();
        return Promise.reject(new NetworkError({ message: "cancelled" }));
      }),
    });
    await flush();
    clock.advance(120_000);
    await expect(done).resolves.toBeUndefined();
  });
});
