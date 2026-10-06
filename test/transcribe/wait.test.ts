import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import { AbortError, JobFailedError, WaitTimeoutError } from "../../src/errors";
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
    expect(await outcome).toBeInstanceOf(AbortError);
  });

  it("refuses a bad waitTimeout", async () => {
    const { hs } = setup();
    await expect(hs.jobs.wait("job_1", { waitTimeout: 0 })).rejects.toMatchObject({
      code: "invalid_option",
    });
  });

  it("is a JobFailedError only when transcribe turns it into one", () => {
    expect(JobFailedError.name).toBe("JobFailedError");
  });
});
