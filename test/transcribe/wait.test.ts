import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import { AbortError, PreflightError, WaitTimeoutError } from "../../src/errors";
import type { Progress } from "../../src/transcribe/types";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock } from "../helpers";
import { driven, fakeApi } from "./fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(): { hs: Hushscript; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock({ manual: true });
  return {
    hs: new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS }),
    clock,
  };
}

describe("hs.jobs.wait", () => {
  it("polls at 5 s, times 1.5, up to 15 s, and reports queued and processing", async () => {
    const { hs, clock } = setup();
    fakeApi({
      jobFlow: [
        { state: "queued", polls: 1 },
        { state: "processing", polls: 5 },
        { state: "done" },
      ],
    });
    const seen: Progress[] = [];
    const sleeps: number[] = [];
    const original = clock.sleep.bind(clock);
    clock.sleep = (ms, signal) => {
      if (ms < 100_000) sleeps.push(ms);
      return original(ms, signal);
    };
    const job = await driven(hs.jobs.wait("job_1", { onProgress: (p) => seen.push(p) }), clock);
    expect(job.state).toBe("done");
    expect(sleeps.slice(0, 5)).toEqual([5000, 7500, 11_250, 15_000, 15_000]);
    expect(seen[0]).toEqual({ stage: "processing", state: "queued" });
    expect(seen.at(-1)).toEqual({ stage: "processing", state: "processing" });
  });

  it("returns a failed job instead of throwing", async () => {
    const { hs, clock } = setup();
    fakeApi({ jobFlow: [{ state: "failed", error: "bad", failure_kind: "media_unreadable" }] });
    const job = await driven(hs.jobs.wait("job_1"), clock);
    expect(job.state).toBe("failed");
  });

  it("raises WaitTimeoutError at waitTimeout, with the last read exactly on the deadline", async () => {
    const { hs, clock } = setup();
    const fake = fakeApi({ jobFlow: [{ state: "processing" }] });
    const error = await driven(hs.jobs.wait("job_1", { waitTimeout: 20 }), clock).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ code: "wait_timeout", status: null });
    expect((error as WaitTimeoutError).resumeToken).toBeNull();
    expect(clock.now()).toBe(20_000);
    expect(fake.count("job")).toBe(4);
  });

  it("is cancelled by its signal during a sleep", async () => {
    const { hs } = setup();
    fakeApi({ jobFlow: [{ state: "processing" }] });
    const stop = new AbortController();
    const outcome = hs.jobs.wait("job_1", { signal: stop.signal }).catch((e: unknown) => e);
    for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    stop.abort();
    const error: unknown = await outcome;
    expect(error).toBeInstanceOf(AbortError);
    expect(error).toMatchObject({ code: "aborted", status: null });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses waitTimeout %s before any request",
    async (waitTimeout) => {
      const { hs } = setup();
      const fake = fakeApi();
      const error: unknown = await hs.jobs
        .wait("job_1", { waitTimeout })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([new Error("caller failed"), "caller failed", null])(
    "propagates a progress callback's thrown value unchanged (%#)",
    async (thrown) => {
      const { hs, clock } = setup();
      const fake = fakeApi({ jobFlow: [{ state: "processing" }] });
      const error: unknown = await driven(
        hs.jobs.wait("job_1", {
          onProgress: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- verifies primitive callback errors
            throw thrown;
          },
        }),
        clock,
      ).catch((e: unknown) => e);
      expect(error).toBe(thrown);
      expect(fake.calls.map((entry) => entry.route)).toEqual(["job"]);
      expect(clock.pending).toHaveLength(0);
    },
  );
});
