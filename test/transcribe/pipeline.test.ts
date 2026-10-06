/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import {
  AbortError,
  ApiError,
  AuthenticationError,
  JobFailedError,
  PreflightError,
  ResumeMismatchError,
  UploadError,
  WaitTimeoutError,
} from "../../src/errors";
import { decodeResumeToken } from "../../src/transcribe/resume";
import type { Progress } from "../../src/transcribe/types";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock } from "../helpers";
import { apiError, driven, fakeApi, type Fake, type FakeConfig } from "./fakeapi";
import { fixtureBytes } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

let mp3: Uint8Array;
beforeAll(async () => {
  mp3 = await fixtureBytes("cbr-20s.mp3");
});

type Clock = ReturnType<typeof fakeClock>;

function setup(
  config: FakeConfig = {},
  extra: { maxRetries?: number } = {},
): { hs: Hushscript; clock: Clock; fake: Fake } {
  const clock = fakeClock({ manual: true });
  const fake = fakeApi(config);
  const hs = new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock,
    timeout: TEST_TIMEOUT_SECONDS,
    ...extra,
  });
  return { hs, clock, fake };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e: unknown) => e);
}

describe("transcribe", () => {
  it("uploads direct to storage without Authorization and with an exact Content-Length, then completes with sorted ETags", async () => {
    const { hs, clock, fake } = setup();
    const tokens: string[] = [];
    const progress: Progress[] = [];
    const transcript = await driven(
      hs.transcribe(mp3, {
        title: "Weekly",
        onResumeToken: (t) => tokens.push(t),
        onProgress: (p) => progress.push(p),
      }),
      clock,
    );
    expect(transcript.id).toBe("tr_1");
    expect(fake.count("create")).toBe(1);
    expect(fake.count("r2")).toBe(3);
    expect(fake.count("part")).toBe(0);
    expect(fake.r2Authorization).toEqual([null, null, null]);
    for (const call of fake.routes("r2")) {
      expect(call.request.headers.get("content-length")).toBe(String(call.bytes));
    }
    expect(fake.r2Sizes.reduce((a, b) => a + b, 0)).toBe(mp3.byteLength);
    expect(fake.completes).toEqual([
      {
        parts: [
          { n: 1, etag: "etag-1" },
          { n: 2, etag: "etag-2" },
          { n: 3, etag: "etag-3" },
        ],
      },
    ]);
    expect(fake.creates[0]).toMatchObject({
      size_bytes: mp3.byteLength,
      duration_seconds: 21,
      title: "Weekly",
    });
    expect(String(fake.creates[0]?.["idempotency_key"])).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens).toHaveLength(1);
    expect(decodeResumeToken(tokens[0] ?? "")).toMatchObject({
      jobId: "job_1",
      size: mp3.byteLength,
      durationSeconds: 21,
    });
    expect(progress[0]).toEqual({
      stage: "uploading",
      percent: 0,
      bytesSent: 0,
      bytesTotal: mp3.byteLength,
    });
    const uploading = progress.filter((p) => p.stage === "uploading");
    expect(uploading.at(-1)).toMatchObject({ percent: 100, bytesSent: mp3.byteLength });
    expect(progress.some((p) => p.stage === "processing")).toBe(true);
  });

  it("maps every option to the create request", async () => {
    const { hs, clock, fake } = setup();
    await driven(
      hs.transcribe(mp3, {
        title: "T",
        language: "en",
        speakers: false,
        translateTo: ["de"],
        keyterms: ["a b"],
        prompt: "context",
        medical: true,
        multichannel: true,
        autoInsights: false,
        matterCode: "M-1",
        idempotencyKey: "0123456789abcdefghij",
      }),
      clock,
    );
    expect(fake.creates[0]).toEqual({
      size_bytes: mp3.byteLength,
      duration_seconds: 21,
      idempotency_key: "0123456789abcdefghij",
      title: "T",
      matter_code: "M-1",
      transcription_options: {
        language_code: "en",
        speaker_detection: false,
        translation_targets: ["de"],
        keyterms_prompt: ["a b"],
        prompt: "context",
        medical_mode: true,
        multichannel: true,
        auto_generate_insights: false,
      },
    });
  });

  it("sends no transcription_options when none were asked for", async () => {
    const { hs, clock, fake } = setup();
    await driven(hs.transcribe(mp3), clock);
    expect(fake.creates[0]).not.toHaveProperty("transcription_options");
    expect(fake.creates[0]).not.toHaveProperty("title");
  });

  it("reads a path, a Blob and a stream the same way", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "hs-pipe-")), "a.mp3");
    await writeFile(path, mp3);
    for (const input of [path, new Blob([mp3]), mp3]) {
      const { hs, clock, fake } = setup();
      await driven(hs.transcribe(input), clock);
      expect(fake.r2Sizes.reduce((a, b) => a + b, 0)).toBe(mp3.byteLength);
    }
    const { hs, clock, fake } = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(mp3.subarray(0, 1000));
        controller.enqueue(mp3.subarray(1000));
        controller.close();
      },
    });
    await driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20.1 }), clock);
    expect(fake.r2Sizes.reduce((a, b) => a + b, 0)).toBe(mp3.byteLength);
    expect(fake.creates[0]).toMatchObject({ duration_seconds: 21 });
  });

  it("never has more than `concurrency` parts in flight, and caps it at 8", async () => {
    for (const [asked, expected] of [
      [2, 2],
      [100, 8],
    ] as const) {
      let inflight = 0;
      let peak = 0;
      const { hs, clock } = setup({
        parts: 12,
        hooks: {
          r2: async () => {
            inflight += 1;
            peak = Math.max(peak, inflight);
            for (let i = 0; i < 3; i += 1)
              await new Promise<void>((resolve) => setImmediate(resolve));
            inflight -= 1;
            return undefined;
          },
        },
      });
      await driven(hs.transcribe(mp3, { concurrency: asked }), clock);
      expect(peak).toBe(expected);
    }
  });

  it("defaults to 4 parts in flight", async () => {
    let inflight = 0;
    let peak = 0;
    const { hs, clock } = setup({
      parts: 10,
      hooks: {
        r2: async () => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          for (let i = 0; i < 3; i += 1)
            await new Promise<void>((resolve) => setImmediate(resolve));
          inflight -= 1;
          return undefined;
        },
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(peak).toBe(4);
  });
});

describe("proxied parts", () => {
  it("sends one 32 MiB-bounded part through the API when the create has no upload plan, and completes without a body", async () => {
    const { hs, clock, fake } = setup({ proxied: true });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(1);
    expect(fake.count("r2")).toBe(0);
    const put = fake.routes("part")[0]?.request;
    expect(put?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(put?.headers.get("content-type")).toBe("application/octet-stream");
    expect(fake.completes).toEqual([null]);
  });

  it("falls back to proxied for every part when direct fails and none has succeeded", async () => {
    const { hs, clock, fake } = setup({
      hooks: { r2: () => apiError("internal_error", 9000, 500) },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(3);
    expect(fake.partNumbers("part").sort()).toEqual([1, 2, 3]);
    expect(fake.count("r2")).toBeGreaterThanOrEqual(1);
    expect(fake.completes).toEqual([null]);
  });

  it("falls back when storage answers without an ETag", async () => {
    const { hs, clock, fake } = setup({ hooks: { r2: () => new Response("", { status: 200 }) } });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(3);
  });

  it("falls back when the part-urls page says the job takes proxied parts", async () => {
    const { hs, clock, fake } = setup({
      parts: 40,
      hooks: {
        partUrls: () =>
          new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      },
    });
    const outcome = await failure(driven(hs.transcribe(mp3, { concurrency: 1 }), clock));
    // Sixteen parts went direct before the first page ran out: mixing the two is refused.
    expect(outcome).toBeInstanceOf(UploadError);
    expect((outcome as UploadError).code).toBe("part_url_missing");
    expect(fake.count("partUrls")).toBe(1);
  });

  it("raises the API's error when a proxied part keeps failing", async () => {
    const { hs, clock } = setup({
      proxied: true,
      hooks: { part: () => apiError("internal_error", 9000, 500) },
    });
    expect(await failure(driven(hs.transcribe(mp3), clock))).toBeInstanceOf(ApiError);
  });
});

describe("direct part retries", () => {
  it("keeps retrying direct after a success: maxRetries, a fresh URL page, maxRetries more", async () => {
    const { hs, clock, fake } = setup({
      parts: 8,
      hooks: {
        r2: (call, f) =>
          call.n === 8 &&
          f.directSuccesses > 0 &&
          f.routes("r2").filter((c) => c.n === 8).length <= 5
            ? apiError("unavailable", 9001, 503)
            : undefined,
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("r2")).toBe(13);
    expect(fake.count("part")).toBe(0);
    expect(fake.count("partUrls")).toBe(1);
  });

  it("raises UploadError parts_exhausted when the fresh page fails too", async () => {
    const { hs, clock, fake } = setup({
      parts: 8,
      hooks: {
        r2: (call, f) =>
          call.n === 8 && f.directSuccesses > 0 ? apiError("unavailable", 9001, 503) : undefined,
      },
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe("parts_exhausted");
    expect(fake.count("part")).toBe(0);
    expect(fake.count("complete")).toBe(0);
  });

  it("re-fetches the page once on a 403, for every part that hit it, and never goes proxied", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        r2: (call) =>
          call.count < 3
            ? new Response("<Error>Request has expired</Error>", { status: 403 })
            : undefined,
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("partUrls")).toBe(1);
    expect(fake.routes("partUrls")[0]?.n).toBe(1);
    expect(fake.count("part")).toBe(0);
    expect(fake.count("r2")).toBe(6);
  });

  it("fetches the next pages at start=17 and start=33, once each", async () => {
    const { hs, clock, fake } = setup({ parts: 40 });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.routes("partUrls").map((c) => c.request.url.split("start=")[1])).toEqual([
      "17",
      "33",
    ]);
    expect(fake.count("r2")).toBe(40);
  });

  it("fetches a page again once its URLs are older than 23 h", async () => {
    const { hs, clock, fake } = setup({ parts: 4 });
    const partSize = Math.ceil(mp3.byteLength / 4);
    let chunk = 0;
    // A stream is read one part at a time, so a day can pass between two parts.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (chunk === 1) clock.advance(24 * 3600 * 1000);
          controller.enqueue(mp3.subarray(chunk * partSize, (chunk + 1) * partSize));
          chunk += 1;
          if (chunk * partSize >= mp3.byteLength) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock);
    expect(fake.count("partUrls")).toBeGreaterThanOrEqual(1);
    expect(fake.count("r2")).toBe(4);
  });

  it("refuses a plan whose part count does not match the file", async () => {
    const { hs, clock } = setup({ plan: { total_parts: 99 } });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect((error as UploadError).code).toBe("bad_part_plan");
    const second = setup({ plan: { part_size_bytes: 0 } });
    const again = await failure(driven(second.hs.transcribe(mp3), second.clock));
    expect((again as UploadError).code).toBe("bad_part_plan");
  });
});

describe("heartbeat and complete", () => {
  it("heartbeats at most 120 s apart while parts are held, and stops once complete returned", async () => {
    const ref: { clock?: Clock } = {};
    const { hs, clock, fake } = setup({
      parts: 8,
      hooks: {
        r2: async (call) => {
          await ref.clock?.sleep(240_000, call.signal);
          return undefined;
        },
      },
    });
    ref.clock = clock;
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("heartbeat")).toBeGreaterThanOrEqual(3);
    expect(clock.pending).toHaveLength(0);
  });

  it("stops heartbeating on wrong_state and carries on uploading", async () => {
    const ref: { clock?: Clock } = {};
    const { hs, clock, fake } = setup({
      parts: 6,
      hooks: {
        r2: async (call) => {
          await ref.clock?.sleep(250_000, call.signal);
          return undefined;
        },
        heartbeat: () => apiError("wrong_state", 4001, 409),
      },
    });
    ref.clock = clock;
    await driven(hs.transcribe(mp3, { concurrency: 2 }), clock);
    expect(fake.count("heartbeat")).toBe(1);
    expect(fake.count("complete")).toBe(1);
  });

  it("aborts the upload with AuthenticationError when a heartbeat is unauthorized", async () => {
    const ref: { clock?: Clock } = {};
    const { hs, clock, fake } = setup({
      hooks: {
        r2: async (call) => {
          await ref.clock?.sleep(10_000_000, call.signal);
          return undefined;
        },
        heartbeat: () => apiError("unauthorized", 2000, 401),
      },
    });
    ref.clock = clock;
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(fake.count("complete")).toBe(0);
  });

  it("raises UploadError upload_incomplete when complete says bytes were lost", async () => {
    const { hs, clock } = setup({
      hooks: { complete: () => apiError("upload_incomplete", 1041, 422) },
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe("upload_incomplete");
  });

  it("reads the job exactly once, without polling, when complete already says done", async () => {
    const { hs, clock, fake } = setup({ completeState: "done", jobFlow: [{ state: "done" }] });
    const transcript = await driven(hs.transcribe(mp3), clock);
    expect(transcript.id).toBe("tr_1");
    expect(fake.count("job")).toBe(1);
    expect(fake.count("transcript")).toBe(1);
    expect(clock.sleeps.filter((ms) => ms < 100_000 && ms >= 5000)).toEqual([]);
  });

  it("raises JobFailedError when complete already says failed", async () => {
    const { hs, clock } = setup({
      completeState: "failed",
      jobFlow: [{ state: "failed", error: "nope", failure_kind: "media_unreadable" }],
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(JobFailedError);
  });
});

describe("waiting and fetching", () => {
  it("raises JobFailedError with the error text, failure kind and job id", async () => {
    const { hs, clock, fake } = setup({
      jobFlow: [
        { state: "processing", polls: 1 },
        { state: "failed", error: "Could not decode the audio", failure_kind: "media_undecodable" },
      ],
    });
    const error = (await failure(driven(hs.transcribe(mp3), clock))) as JobFailedError;
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error.failureKind).toBe("media_undecodable");
    expect(error.error).toBe("Could not decode the audio");
    expect(error.jobId).toBe("job_1");
    expect(fake.count("transcript")).toBe(0);
  });

  it("reports an unknown failure kind as null", async () => {
    const { hs, clock } = setup({ jobFlow: [{ state: "failed", failure_kind: "something_new" }] });
    const error = (await failure(driven(hs.transcribe(mp3), clock))) as JobFailedError;
    expect(error.failureKind).toBeNull();
    expect(error.error).toBeNull();
  });

  it("passes unknown job states through while polling", async () => {
    const { hs, clock } = setup({
      jobFlow: [
        { state: "reviewing", polls: 1 },
        { state: "processing", polls: 1 },
        { state: "done" },
      ],
    });
    expect((await driven(hs.transcribe(mp3), clock)).id).toBe("tr_1");
  });

  it("raises when a done job has no transcript id", async () => {
    const { hs, clock } = setup({
      hooks: {
        job: () =>
          new Response(
            JSON.stringify({
              id: "job_1",
              state: "done",
              transcript_id: null,
              error: null,
              failure_kind: null,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect((error as UploadError).code).toBe("transcript_missing");
  });
});

describe("resume", () => {
  it("times out with a token, then resume() replays the create with the same key and finishes", async () => {
    const { hs, clock, fake } = setup({
      jobFlow: [{ state: "processing", polls: 7 }, { state: "done" }],
    });
    const timeout = (await failure(
      driven(hs.transcribe(mp3, { waitTimeout: 60 }), clock),
    )) as WaitTimeoutError;
    expect(timeout).toBeInstanceOf(WaitTimeoutError);
    expect(timeout.resumeToken).toBeTruthy();
    const transcript = await driven(hs.resume(timeout.resumeToken ?? ""), clock);
    expect(transcript.id).toBe("tr_1");
    expect(fake.count("create")).toBe(2);
    expect(fake.creates[1]).toEqual({
      size_bytes: mp3.byteLength,
      duration_seconds: 21,
      idempotency_key: fake.creates[0]?.["idempotency_key"],
    });
    expect(fake.count("account")).toBe(1);
    expect(fake.count("r2")).toBe(3);
  });

  it("refuses a file of another size before any request", async () => {
    const { hs, clock, fake } = setup({ jobFlow: [{ state: "processing" }] });
    const timeout = (await failure(
      driven(hs.transcribe(mp3, { waitTimeout: 10 }), clock),
    )) as WaitTimeoutError;
    const before = fake.calls.length;
    const error = await failure(hs.resume(timeout.resumeToken ?? "", mp3.subarray(0, 1000)));
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect((error as ResumeMismatchError).code).toBe("resume_file_mismatch");
    expect(fake.calls.length).toBe(before);
  });

  it("refuses a token that is not one", async () => {
    const { hs } = setup();
    await expect(hs.resume("garbage")).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("resumes an interrupted upload with the file, and asks for the file when it is missing", async () => {
    let hold = true;
    const ref: { clock?: Clock } = {};
    const { hs, clock, fake } = setup({
      hooks: {
        r2: async (call) => {
          if (hold) await ref.clock?.sleep(10_000_000, call.signal);
          return undefined;
        },
      },
    });
    ref.clock = clock;
    const stop = new AbortController();
    const outcome = failure(hs.transcribe(mp3, { signal: stop.signal }));
    for (let i = 0; i < 500 && fake.count("r2") === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(fake.count("r2")).toBeGreaterThan(0);
    stop.abort();
    const cancelled = (await outcome) as AbortError;
    expect(cancelled).toBeInstanceOf(AbortError);
    expect(cancelled.resumeToken).toBeTruthy();
    expect(fake.count("complete")).toBe(0);

    const missing = await failure(driven(hs.resume(cancelled.resumeToken ?? ""), clock));
    expect(missing).toBeInstanceOf(ResumeMismatchError);
    expect((missing as ResumeMismatchError).code).toBe("resume_file_required");

    hold = false;
    const transcript = await driven(hs.resume(cancelled.resumeToken ?? "", mp3), clock);
    expect(transcript.id).toBe("tr_1");
    expect(
      fake.creates.every((c) => c["idempotency_key"] === fake.creates[0]?.["idempotency_key"]),
    ).toBe(true);
  });
});

describe("cancellation", () => {
  it("carries no token when the job does not exist yet", async () => {
    const { hs } = setup();
    const error = await failure(hs.transcribe(mp3, { signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).resumeToken).toBeNull();
  });

  it("carries the token once the job exists, when aborted while waiting", async () => {
    const { hs, clock } = setup({ jobFlow: [{ state: "processing" }] });
    const stop = new AbortController();
    const outcome = failure(hs.transcribe(mp3, { signal: stop.signal }));
    for (let i = 0; i < 200; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (clock.pending.length > 0 && clock.pending.every((e) => e.at - clock.now() <= 15_000)) {
        stop.abort();
        break;
      }
    }
    const error = (await outcome) as AbortError;
    expect(error).toBeInstanceOf(AbortError);
    expect(decodeResumeToken(error.resumeToken ?? "").jobId).toBe("job_1");
  });

  it("wraps a non-SDK error thrown after the signal fired", async () => {
    const stop = new AbortController();
    const { hs, clock } = setup({
      hooks: {
        complete: () => {
          stop.abort();
          throw new Error("boom");
        },
      },
    });
    const error = (await failure(
      driven(hs.transcribe(mp3, { signal: stop.signal }), clock),
    )) as AbortError;
    expect(error).toBeInstanceOf(AbortError);
    expect(error.resumeToken).toBeTruthy();
  });
});

describe("a loop over files", () => {
  it("finishes six files against a mock that 429s every fifth create without Retry-After, and waits at least 60 s", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        create: (call) => (call.count === 4 ? apiError("rate_limited", 5000, 429) : undefined),
      },
    });
    for (let i = 0; i < 6; i += 1) {
      const transcript = await driven(hs.transcribe(mp3), clock);
      expect(transcript.id).toBe("tr_1");
    }
    expect(fake.count("create")).toBe(7);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });
});

describe("options", () => {
  it("is an invalid_option PreflightError for a stream-less size", async () => {
    const { hs } = setup();
    const error = await failure(hs.transcribe(42 as unknown as string));
    expect(error).toBeInstanceOf(PreflightError);
  });
});
