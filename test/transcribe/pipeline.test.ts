/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import {
  AbortError,
  ApiError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  FileLimitError,
  HushscriptError,
  JobFailedError,
  NotFoundError,
  PreflightError,
  ResumeMismatchError,
  UploadError,
  WaitTimeoutError,
} from "../../src/errors";
import { decodeResumeToken, encodeResumeToken } from "../../src/transcribe/resume";
import type { Progress } from "../../src/transcribe/types";
import {
  BASE,
  JOB_OPTIONS,
  TEST_TIMEOUT_SECONDS,
  TOKEN,
  fakeClock,
  networkError,
} from "../helpers";
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

  it("reports the state complete answered before polling, and only for queued or processing", async () => {
    const statesSeen = async (config: FakeConfig): Promise<Progress[]> => {
      const { hs, clock } = setup(config);
      const progress: Progress[] = [];
      await driven(hs.transcribe(mp3, { onProgress: (p) => progress.push(p) }), clock);
      return progress.filter((p) => p.stage !== "uploading");
    };
    expect(await statesSeen({ completeState: "queued" })).toEqual([
      { stage: "processing", state: "queued" },
      { stage: "processing", state: "processing" },
    ]);
    expect(
      await statesSeen({
        completeState: "processing",
        jobFlow: [{ state: "queued", polls: 1 }, { state: "done" }],
      }),
    ).toEqual([
      { stage: "processing", state: "processing" },
      { stage: "processing", state: "queued" },
    ]);
    expect(
      await statesSeen({
        completeState: "reviewing",
        jobFlow: [{ state: "reviewing", polls: 1 }, { state: "done" }],
      }),
    ).toEqual([]);
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

  it("sends trimmed key terms and prompt, and leaves out blank ones", async () => {
    const trimmed = setup();
    await driven(
      trimmed.hs.transcribe(mp3, { keyterms: [" a b ", "", "\t"], prompt: "  context\n" }),
      trimmed.clock,
    );
    expect(trimmed.fake.creates[0]?.["transcription_options"]).toEqual({
      keyterms_prompt: ["a b"],
      prompt: "context",
    });
    const blank = setup();
    await driven(blank.hs.transcribe(mp3, { keyterms: [" "], prompt: " \n" }), blank.clock);
    expect(blank.fake.creates[0]).not.toHaveProperty("transcription_options");
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

  it("never has more than `concurrency` parts in flight, up to 8", async () => {
    for (const [asked, expected] of [
      [2, 2],
      [8, 8],
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
    // Only a 403 earns a fresh page before any direct PUT has worked.
    expect(fake.count("partUrls")).toBe(0);
    expect(fake.completes).toEqual([null]);
  });

  it("falls back when storage answers without an ETag", async () => {
    const { hs, clock, fake } = setup({ hooks: { r2: () => new Response("", { status: 200 }) } });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(3);
    expect(fake.count("partUrls")).toBe(0);
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
    expect((outcome as UploadError).message).toBe("No upload URL for part 17.");
    expect(fake.count("partUrls")).toBe(1);
  });

  it("goes proxied for every part when the create answers part_urls: null", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        create: () =>
          Response.json({
            job_id: "job_1",
            state: "uploading",
            upload: {
              part_size_bytes: Math.ceil(mp3.byteLength / 3),
              total_parts: 3,
              part_urls: null,
              next_part_number: null,
            },
          }),
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(3);
    expect(fake.count("r2")).toBe(0);
    expect(fake.count("partUrls")).toBe(0);
    expect(fake.completes).toEqual([null]);
  });

  it("goes proxied for every part when the first part-urls page answers part_urls: null", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        create: () =>
          Response.json({
            job_id: "job_1",
            state: "uploading",
            upload: {
              part_size_bytes: Math.ceil(mp3.byteLength / 3),
              total_parts: 3,
              part_urls: [],
              next_part_number: 1,
            },
          }),
        partUrls: () => Response.json({ part_urls: null, next_part_number: null }),
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("partUrls")).toBe(1);
    expect(fake.count("part")).toBe(3);
    expect(fake.count("r2")).toBe(0);
    expect(fake.completes).toEqual([null]);
  });

  it("goes proxied for every part when the first part-urls page answers 404", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        create: () =>
          Response.json({
            job_id: "job_1",
            state: "uploading",
            upload: {
              part_size_bytes: Math.ceil(mp3.byteLength / 3),
              total_parts: 3,
              part_urls: [],
              next_part_number: 1,
            },
          }),
        partUrls: () => apiError("not_found", 4000, 404),
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("partUrls")).toBe(1);
    expect(fake.count("part")).toBe(3);
    expect(fake.count("r2")).toBe(0);
    expect(fake.completes).toEqual([null]);
  });

  it("keeps the meaning of a 404 from a proxied part", async () => {
    const { hs, clock } = setup({
      proxied: true,
      hooks: { part: () => apiError("not_found", 4000, 404) },
    });
    expect(await failure(driven(hs.transcribe(mp3), clock))).toBeInstanceOf(NotFoundError);
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
    expect((error as UploadError).message).toBe("Part 8 failed after retries and a fresh URL.");
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

  it("refuses a plan whose part count does not match the file, and one with no part size", async () => {
    const { hs, clock } = setup({ plan: { total_parts: 99 } });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect((error as UploadError).code).toBe("bad_part_plan");
    const second = setup({ plan: { part_size_bytes: 0 } });
    const again = await failure(driven(second.hs.transcribe(mp3), second.clock));
    // A part size of zero never fits the shape of a create answer, so it is the answer that is refused.
    expect(again).toBeInstanceOf(ApiError);
    expect((again as ApiError).code).toBe("bad_response");
  });
});

describe("heartbeat and complete", () => {
  it("heartbeats every 120 s while parts are held, and stops once complete returned", async () => {
    const ref: { clock?: Clock } = {};
    const { hs, clock, fake } = setup({
      parts: 8,
      hooks: {
        r2: async (call) => {
          await ref.clock?.sleep(250_000, call.signal);
          return undefined;
        },
      },
    });
    ref.clock = clock;
    await driven(hs.transcribe(mp3, { concurrency: 2 }), clock);
    expect(fake.count("heartbeat")).toBe(8);
    expect(
      new Set(fake.routes("heartbeat").map((call) => new URL(call.request.url).pathname)),
    ).toEqual(new Set(["/v1/uploads/job_1/heartbeat"]));
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
    expect(error).toMatchObject({
      code: "unauthorized",
      status: 401,
      idempotencyKey: fake.creates[0]?.["idempotency_key"],
    });
    expect(decodeResumeToken((error as AuthenticationError).resumeToken ?? "")).toEqual({
      jobId: "job_1",
      idempotencyKey: fake.creates[0]?.["idempotency_key"],
      size: mp3.byteLength,
      durationSeconds: 21,
    });
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
    const { hs, clock, fake } = setup({
      completeState: "failed",
      jobFlow: [{ state: "failed", error: "nope", failure_kind: "media_unreadable" }],
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({
      code: "job_failed",
      status: null,
      failureKind: "media_unreadable",
      error: "nope",
      jobId: "job_1",
    });
    expect(fake.count("job")).toBe(1);
    expect(clock.sleeps.filter((ms) => ms >= 5000 && ms < 100_000)).toEqual([]);
    expect(fake.count("transcript")).toBe(0);
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
    expect(error.message).toBe("The job failed.");
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
              mode: "standard",
              declared_seconds: 21,
              verified_seconds: 20,
              actual_seconds: 20,
              billable_seconds: 20,
              transcript_id: null,
              error: null,
              failure_kind: null,
              retry_of: null,
              created_at: 1,
              options: JOB_OPTIONS,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "transcript_missing",
      status: null,
      message: "The job is done but has no transcript id.",
    });
  });
});

describe("resume", () => {
  it("times out with a token, then resume() reads the job and, as it already left uploading, only waits", async () => {
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
    expect(fake.count("create")).toBe(1);
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
    const { hs, fake } = setup();
    const error = await failure(hs.resume("garbage"));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ code: "config_invalid", status: null });
    expect(fake.calls).toHaveLength(0);
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

    const createsBefore = fake.count("create");
    const missing = await failure(driven(hs.resume(cancelled.resumeToken ?? ""), clock));
    expect(missing).toBeInstanceOf(ResumeMismatchError);
    expect((missing as ResumeMismatchError).code).toBe("resume_file_required");
    // Refused before the replay: a create that is not going to be used must not hold minutes.
    expect(fake.count("create")).toBe(createsBefore);

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
    const { hs, fake } = setup();
    const error = await failure(hs.transcribe(mp3, { signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).resumeToken).toBeNull();
    expect(error).toMatchObject({ code: "aborted", status: null, idempotencyKey: null });
    expect(fake.calls).toHaveLength(0);
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
    // The fetch layer turns the hook failure into the signal's abort before the pipeline sees it;
    // that original error is kept as the cause (a redacted copy, so matched by name and code).
    expect(error.cause).toMatchObject({ name: "AbortError", code: "aborted" });
    expect(error.cause).not.toBe(error);
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

describe("options (spec 7.3, 8.6)", () => {
  it("is an invalid_option PreflightError for a stream-less size", async () => {
    const { hs, fake } = setup();
    const error = await failure(hs.transcribe(42 as unknown as string));
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "invalid_option", status: null });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([0, 9, 100, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses concurrency %s as invalid_option before any request, never clamping it",
    async (concurrency) => {
      const { hs, fake } = setup();
      const error = await failure(hs.transcribe(mp3, { concurrency }));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        status: null,
        message: "concurrency must be a whole number from 1 to 8.",
      });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    "refuses durationSeconds %s as invalid_option, not as an out-of-range file",
    async (durationSeconds) => {
      const { hs, fake } = setup();
      const error = await failure(hs.transcribe(mp3, { durationSeconds }));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).not.toBeInstanceOf(FileLimitError);
      expect(error).toMatchObject({
        code: "invalid_option",
        status: null,
        message: "durationSeconds must be a finite number of seconds, above 0.",
      });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([10, 14.99, 36_000.01, 36_001, 40_000])(
    "refuses a finite durationSeconds of %s as duration_out_of_range",
    async (durationSeconds) => {
      const { hs, fake } = setup();
      const error = await failure(hs.transcribe(mp3, { durationSeconds }));
      expect(error).toBeInstanceOf(FileLimitError);
      expect(error).toMatchObject({ code: "duration_out_of_range", status: null });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a stream size of %s as invalid_option",
    async (size) => {
      const { hs, fake } = setup();
      const stream = new ReadableStream<Uint8Array>();
      const error = await failure(hs.transcribe(stream, { size, durationSeconds: 20 }));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9])(
    "refuses concurrency %s on resume before any request",
    async (concurrency) => {
      const { hs, fake } = setup();
      const token = encodeResumeToken({
        jobId: "job_1",
        idempotencyKey: "0123456789abcdefghij",
        size: mp3.byteLength,
        durationSeconds: 21,
      });
      const error = await failure(hs.resume(token, mp3, { concurrency }));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(fake.calls).toHaveLength(0);
    },
  );
});

describe("invalid wait options across transcribe and resume", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses waitTimeout %s before any request on both surfaces",
    async (value) => {
      const { hs, fake } = setup();
      const token = encodeResumeToken({
        jobId: "job_1",
        idempotencyKey: "0123456789abcdef",
        size: mp3.byteLength,
        durationSeconds: 21,
      });
      for (const call of [
        () => hs.transcribe(mp3, { waitTimeout: value }),
        () => hs.resume(token, mp3, { waitTimeout: value }),
      ]) {
        const error = await failure(call());
        expect(error).toBeInstanceOf(PreflightError);
        expect(error).toMatchObject({
          code: "invalid_option",
          status: null,
          message: "waitTimeout must be a positive number of seconds.",
        });
        expect(fake.calls).toHaveLength(0);
      }
    },
  );

  it.each(["uploading", "processing"])(
    "returns the resume %s progress callback error unchanged and sends nothing further",
    async (state) => {
      const { hs, clock, fake } = setup({ jobFlow: [{ state }] });
      const token = encodeResumeToken({
        jobId: "job_1",
        idempotencyKey: "0123456789abcdef",
        size: mp3.byteLength,
        durationSeconds: 21,
      });
      const thrown = new Error("caller failed");
      const error = await failure(
        driven(
          hs.resume(token, mp3, {
            onProgress: () => {
              throw thrown;
            },
          }),
          clock,
        ),
      );
      expect(error).toBe(thrown);
      expect(fake.calls.map((entry) => entry.route)).toEqual(["job"]);
    },
  );

  it.each([new Error("caller failed"), "caller failed", null])(
    "returns the resume token callback error unchanged and sends nothing further (%#)",
    async (thrown) => {
      const { hs, clock, fake } = setup();
      const error = await failure(
        driven(
          hs.transcribe(mp3, {
            onResumeToken: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- verifies primitive callback errors
              throw thrown;
            },
          }),
          clock,
        ),
      );
      expect(error).toBe(thrown);
      expect(fake.calls.map((entry) => entry.route)).toEqual(["account", "create"]);
    },
  );

  it.each([new Error("caller failed"), "caller failed", null])(
    "returns the 0 percent progress callback error unchanged before create (%#)",
    async (thrown) => {
      const { hs, fake } = setup();
      const error = await failure(
        hs.transcribe(mp3, {
          onProgress: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- verifies primitive callback errors
            throw thrown;
          },
        }),
      );
      expect(error).toBe(thrown);
      expect(fake.calls.map((entry) => entry.route)).toEqual(["account"]);
    },
  );
});

describe("streams of the wrong size (spec 7.3)", () => {
  function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes.subarray(0, 1000));
        controller.enqueue(bytes.subarray(1000));
        controller.close();
      },
    });
  }

  it("raises stream_size_mismatch before complete when the stream has more bytes than size", async () => {
    const { hs, clock, fake } = setup();
    const longer = new Uint8Array(mp3.byteLength + 10);
    longer.set(mp3);
    const error = await failure(
      driven(hs.transcribe(streamOf(longer), { size: mp3.byteLength, durationSeconds: 20 }), clock),
    );
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe("stream_size_mismatch");
    expect(fake.count("complete")).toBe(0);
  });

  it("raises stream_size_mismatch before complete when the stream has fewer bytes", async () => {
    const { hs, clock, fake } = setup();
    const error = await failure(
      driven(
        hs.transcribe(streamOf(mp3.subarray(0, mp3.byteLength - 10)), {
          size: mp3.byteLength,
          durationSeconds: 20,
        }),
        clock,
      ),
    );
    expect((error as UploadError).code).toBe("stream_size_mismatch");
    expect(fake.count("complete")).toBe(0);
  });
});

describe("resume against the job's real state (spec 7.3)", () => {
  function heldParts(): { config: FakeConfig; bind: (clock: Clock) => void; release: () => void } {
    const ref: { clock?: Clock; held: boolean } = { held: true };
    return {
      config: {
        hooks: {
          r2: async (call) => {
            if (ref.held) await ref.clock?.sleep(10_000_000, call.signal);
            return undefined;
          },
        },
      },
      bind: (clock) => {
        ref.clock = clock;
      },
      release: () => {
        ref.held = false;
      },
    };
  }

  async function interrupted(ctx: { hs: Hushscript; fake: Fake }): Promise<string> {
    const stop = new AbortController();
    const outcome = failure(ctx.hs.transcribe(mp3, { signal: stop.signal }));
    for (let i = 0; i < 500 && ctx.fake.count("r2") === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    stop.abort();
    const cancelled = (await outcome) as AbortError;
    return cancelled.resumeToken ?? "";
  }

  it("raises resume_job_missing for a job that is gone, without a create or a hold", async () => {
    const { hs, fake } = setup({ strictJobs: true });
    const token = encodeResumeToken({
      jobId: "job_gone",
      idempotencyKey: "0123456789abcdefghij",
      size: mp3.byteLength,
      durationSeconds: 21,
    });
    const error = await failure(hs.resume(token, mp3));
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect((error as ResumeMismatchError).code).toBe("resume_job_missing");
    expect((error as ResumeMismatchError).hint).toBe(
      "This job no longer exists. Start a new transcription.",
    );
    expect(fake.calls.map((entry) => entry.route)).toEqual(["job"]);
  });

  it("raises resume_job_missing, with no file needed, for a finished job that was deleted", async () => {
    const { hs, fake } = setup({ strictJobs: true });
    const token = encodeResumeToken({
      jobId: "job_gone",
      idempotencyKey: "0123456789abcdefghij",
      size: mp3.byteLength,
      durationSeconds: 21,
    });
    const error = await failure(hs.resume(token));
    expect((error as ResumeMismatchError).code).toBe("resume_job_missing");
    expect(fake.count("create")).toBe(0);
  });

  it("refuses a replay that comes back with another job id, and sends nothing after it", async () => {
    const held = heldParts();
    const { hs, clock, fake } = setup({ ...held.config, replayAs: "job_other" });
    held.bind(clock);
    const token = await interrupted({ hs, fake });
    held.release();
    const before = fake.calls.length;
    const error = await failure(driven(hs.resume(token, mp3), clock));
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect((error as ResumeMismatchError).code).toBe("resume_job_missing");
    const after = fake.calls.slice(before).map((entry) => entry.route);
    expect(after).toEqual(["job", "create"]);
  });

  it("replays the create and finishes the upload when the job is still uploading", async () => {
    const held = heldParts();
    const { hs, clock, fake } = setup(held.config);
    held.bind(clock);
    const token = await interrupted({ hs, fake });
    held.release();
    const transcript = await driven(hs.resume(token, mp3), clock);
    expect(transcript.id).toBe("tr_1");
    expect(fake.count("create")).toBe(2);
    expect(fake.jobCount()).toBe(1);
    expect(fake.count("complete")).toBe(1);
  });

  it("uses the job it read when it already failed: one job read, no poll", async () => {
    const { hs, clock, fake } = setup({
      jobFlow: [{ state: "failed", error: "nope", failure_kind: "media_unreadable" }],
    });
    const token = encodeResumeToken({
      jobId: "job_1",
      idempotencyKey: "0123456789abcdefghij",
      size: mp3.byteLength,
      durationSeconds: 21,
    });
    const error = await failure(driven(hs.resume(token), clock));
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({ error: "nope", jobId: "job_1" });
    expect(fake.calls.map((entry) => entry.route)).toEqual(["job"]);
  });

  it("refuses a path that changed size while the job was read, before the replay", async () => {
    const held = heldParts();
    const path = join(await mkdtemp(join(tmpdir(), "hs-path-")), "a.mp3");
    await writeFile(path, mp3);
    const { hs, clock, fake } = setup({
      hooks: {
        ...held.config.hooks,
        // Synchronous, so the manual clock does not run the request timeout while it writes.
        job: () => {
          writeFileSync(path, mp3.subarray(0, 1000));
          return undefined;
        },
      },
    });
    held.bind(clock);
    const token = await interrupted({ hs, fake });
    held.release();
    const error = await failure(driven(hs.resume(token, path), clock));
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect(error).toMatchObject({
      code: "resume_file_mismatch",
      message: `The file is 1000 bytes; the upload started with ${String(mp3.byteLength)} bytes.`,
    });
    expect(fake.count("create")).toBe(1);
  });

  it("uses the job it read when it is already done: no create, one job read", async () => {
    const { hs, clock, fake } = setup({ jobFlow: [{ state: "done" }] });
    const tokens: string[] = [];
    await driven(hs.transcribe(mp3, { onResumeToken: (t) => tokens.push(t) }), clock);
    const reads = fake.count("job");
    const transcript = await driven(hs.resume(tokens[0] ?? ""), clock);
    expect(transcript.id).toBe("tr_1");
    expect(fake.count("create")).toBe(1);
    expect(fake.count("job") - reads).toBe(1);
  });
});

describe("a failed heartbeat during complete (spec 8.5)", () => {
  it("surfaces AuthenticationError, not the abort it caused", async () => {
    const ref: { clock?: Clock; completing: boolean } = { completing: false };
    const { hs, clock } = setup({
      hooks: {
        complete: async (call) => {
          ref.completing = true;
          await ref.clock?.sleep(10_000_000, call.signal);
          return undefined;
        },
        heartbeat: () => (ref.completing ? apiError("unauthorized", 2000, 401) : undefined),
      },
    });
    ref.clock = clock;
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(AuthenticationError);
  });
});

describe("part-urls failures (spec 8.4)", () => {
  it("falls back to proxied parts when a 403 refresh cannot get a new page and no direct PUT ever worked", async () => {
    const { hs, clock, fake } = setup({
      hooks: {
        r2: () => new Response("<Error>expired</Error>", { status: 403 }),
        partUrls: () => apiError("internal_error", 9000, 500),
      },
    });
    await driven(hs.transcribe(mp3), clock);
    expect(fake.count("part")).toBe(3);
    expect(fake.completes).toEqual([null]);
  });

  it("raises parts_exhausted when the next page cannot be fetched after direct PUTs worked", async () => {
    const { hs, clock, fake } = setup({
      parts: 40,
      hooks: { partUrls: () => apiError("internal_error", 9000, 500) },
    });
    const error = await failure(driven(hs.transcribe(mp3, { concurrency: 1 }), clock));
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe("parts_exhausted");
    expect((error as UploadError).cause).toMatchObject({
      name: "ApiError",
      code: "internal_error",
    });
    expect(fake.count("complete")).toBe(0);
  });

  it("surfaces a 401 from the next page as AuthenticationError, not parts_exhausted", async () => {
    const { hs, clock, fake } = setup({
      parts: 40,
      hooks: { partUrls: () => apiError("unauthorized", 2000, 401) },
    });
    const error = await failure(driven(hs.transcribe(mp3, { concurrency: 1 }), clock));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(fake.count("complete")).toBe(0);
  });

  it("surfaces a 401 from the refresh after an R2 403 once direct PUTs worked", async () => {
    const { hs, clock } = setup({
      parts: 8,
      hooks: {
        r2: (call, f) =>
          call.n === 8 && f.directSuccesses > 0
            ? new Response("<Error>expired</Error>", { status: 403 })
            : undefined,
        partUrls: () => apiError("unauthorized", 2000, 401),
      },
    });
    const error = await failure(driven(hs.transcribe(mp3), clock));
    expect(error).toBeInstanceOf(AuthenticationError);
  });

  it("stops a page fetch that is still running when another part has failed", async () => {
    let aborted = false;
    let fetchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const { hs, clock } = setup({
      parts: 40,
      hooks: {
        partUrls: async (call) => {
          fetchStarted();
          await new Promise<void>((resolve) => {
            call.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          });
          return undefined;
        },
      },
    });
    const partSize = Math.ceil(mp3.byteLength / 40);
    const blob = new Blob([mp3]);
    const slice = blob.slice.bind(blob);
    blob.slice = (start?: number, end?: number, type?: string): Blob => {
      const part = slice(start, end, type);
      if ((start ?? 0) >= 17 * partSize) {
        // The read fails only once the page fetch is under way, so the abort has something to stop.
        part.arrayBuffer = async (): Promise<ArrayBuffer> => {
          await started;
          throw new Error("disk gone");
        };
      }
      return part;
    };
    const error = await failure(
      driven(hs.transcribe(blob, { concurrency: 2, durationSeconds: 20 }), clock),
    );
    expect(error).toMatchObject({ name: "UploadError", code: "source_read_failed" });
    expect(((error as Error).cause as Error).message).toBe("disk gone");
    expect(aborted).toBe(true);
  });
});

describe("errors after the create was sent (spec 7.3)", () => {
  it("carries the key when the create's answer is lost, and the key replays the same job", async () => {
    const clock = fakeClock({ manual: true });
    const fake = fakeApi();
    const real = globalThis.fetch;
    let dropped = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        !dropped &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/uploads"
      ) {
        dropped = true;
        await real(request);
        throw networkError("ECONNRESET");
      }
      return real(request);
    });
    const hs = new Hushscript({
      token: TOKEN,
      baseUrl: BASE,
      clock,
      timeout: TEST_TIMEOUT_SECONDS,
      maxRetries: 0,
    });
    const lost = await failure(driven(hs.transcribe(mp3), clock));
    expect(lost).toBeInstanceOf(NetworkError);
    expect(lost).toMatchObject({ code: "network_error", status: null });
    const key = (lost as HushscriptError).idempotencyKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect((lost as HushscriptError).resumeToken).toBeNull();
    expect(fake.jobCount()).toBe(1);

    const tokens: string[] = [];
    const transcript = await driven(
      hs.transcribe(mp3, { idempotencyKey: key ?? "", onResumeToken: (t) => tokens.push(t) }),
      clock,
    );
    expect(transcript.id).toBe("tr_1");
    expect(fake.jobCount()).toBe(1);
    expect(decodeResumeToken(tokens[0] ?? "").jobId).toBe("job_1");
    expect(fake.creates.map((c) => c["idempotency_key"])).toEqual([key, key]);
  });

  it("carries the key and the token on an error from the upload, once the job id is known", async () => {
    const { hs, clock } = setup({
      hooks: { complete: () => apiError("upload_incomplete", 1041, 422) },
    });
    const tokens: string[] = [];
    const error = (await failure(
      driven(hs.transcribe(mp3, { onResumeToken: (t) => tokens.push(t) }), clock),
    )) as HushscriptError;
    expect(error.idempotencyKey).toBe(decodeResumeToken(tokens[0] ?? "").idempotencyKey);
    expect(error.resumeToken).toBe(tokens[0]);
  });

  it("carries a key on a caller abort during the create, and no token", async () => {
    const stop = new AbortController();
    const { hs, fake } = setup({
      hooks: {
        create: () => {
          stop.abort();
          throw new Error("never answered");
        },
      },
    });
    const error = (await failure(hs.transcribe(mp3, { signal: stop.signal }))) as AbortError;
    expect(error).toBeInstanceOf(AbortError);
    expect(error).toMatchObject({ code: "aborted", status: null });
    const create = JSON.parse(fake.routes("create")[0]?.body ?? "{}") as Record<string, unknown>;
    expect(error.idempotencyKey).toBe(create["idempotency_key"]);
    expect(error.resumeToken).toBeNull();
    // The fetch layer's abort, keyed as it was: with no token there is nothing to wrap it for.
    expect((error.cause as { code?: unknown }).code).not.toBe("aborted");
  });

  it("hands back an error from before the create as it was, with nothing added", async () => {
    const { hs, fake } = setup();
    const locked = new ReadableStream<Uint8Array>();
    locked.getReader();
    const error = await failure(hs.transcribe(locked, { size: 1000, durationSeconds: 20 }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(HushscriptError);
    expect("idempotencyKey" in (error as object)).toBe(false);
    expect("resumeToken" in (error as object)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  /** A caller's clock that throws `thrown` from now() once `arm` was called. */
  function brokenClock(thrown: unknown): {
    hs: Hushscript;
    fake: Fake;
    base: Clock;
    arm: () => void;
  } {
    const base = fakeClock({ manual: true });
    const fake = fakeApi();
    let armed = false;
    const clock = {
      ...base,
      now: (): number => {
        if (armed) throw thrown;
        return base.now();
      },
    };
    const hs = new Hushscript({
      token: TOKEN,
      baseUrl: BASE,
      clock,
      timeout: TEST_TIMEOUT_SECONDS,
    });
    return {
      hs,
      fake,
      base,
      arm: () => {
        armed = true;
      },
    };
  }

  it("wraps a plain error from after the create as unexpected_error, with the key and the token", async () => {
    const { hs, fake, base, arm } = brokenClock(new Error("clock broke"));
    const tokens: string[] = [];
    const error = await failure(
      driven(
        hs.transcribe(mp3, {
          onResumeToken: (t) => tokens.push(t),
          onProgress: (p) => {
            if (p.stage === "processing") arm();
          },
        }),
        base,
      ),
    );
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({
      code: "unexpected_error",
      message: "The SDK failed unexpectedly (Error: clock broke).",
      idempotencyKey: fake.creates[0]?.["idempotency_key"],
      resumeToken: tokens[0],
    });
    expect(((error as Error).cause as Error).message).toBe("clock broke");
  });

  it("turns a thrown non-Error after the caller aborted into an AbortError with the token", async () => {
    const { hs, fake, base, arm } = brokenClock("clock broke");
    const stop = new AbortController();
    const tokens: string[] = [];
    const error = await failure(
      driven(
        hs.transcribe(mp3, {
          signal: stop.signal,
          onResumeToken: (t) => tokens.push(t),
          onProgress: (p) => {
            if (p.stage !== "processing") return;
            stop.abort();
            arm();
          },
        }),
        base,
      ),
    );
    expect(error).toBeInstanceOf(AbortError);
    expect(error).toMatchObject({
      code: "aborted",
      message: "The request was aborted.",
      idempotencyKey: fake.creates[0]?.["idempotency_key"],
      resumeToken: tokens[0],
    });
    expect((error as Error).cause).toBe("clock broke");
  });

  it("carries no key on a refusal that came before the create", async () => {
    const { hs } = setup();
    const error = (await failure(hs.transcribe(new Uint8Array(2000)))) as HushscriptError;
    expect(error.idempotencyKey).toBeNull();
    expect(error.resumeToken).toBeNull();
  });

  it("hands back, never wrapped as an abort, an error a callback throws after the signal fired", async () => {
    const stop = new AbortController();
    const { hs, clock } = setup();
    const thrown = new Error("boom");
    const error = await failure(
      driven(
        hs.transcribe(mp3, {
          signal: stop.signal,
          onProgress: (progress) => {
            if (progress.stage === "uploading" && progress.percent === 100) {
              stop.abort();
              throw thrown;
            }
          },
        }),
        clock,
      ),
    );
    expect(error).toBe(thrown);
  });
});

describe("callback errors with several workers", () => {
  it("hands back the object a callback threw when two workers throw distinct errors", async () => {
    const { hs, clock } = setup({ parts: 3 });
    const thrown: Error[] = [];
    const error = await failure(
      driven(
        hs.transcribe(mp3, {
          concurrency: 3,
          onProgress: (progress) => {
            if (progress.stage === "uploading" && progress.percent > 0 && thrown.length < 2) {
              const next = new Error(`callback ${String(thrown.length)}`);
              thrown.push(next);
              throw next;
            }
          },
        }),
        clock,
      ),
    );
    expect(thrown).toHaveLength(2);
    expect(thrown).toContain(error);
  });

  it("hands back a thrown primitive untouched", async () => {
    const { hs, clock } = setup();
    const error = await failure(
      driven(
        hs.transcribe(mp3, {
          onProgress: (progress) => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
            if (progress.stage === "uploading" && progress.percent > 0) throw "plain string";
          },
        }),
        clock,
      ),
    );
    expect(error).toBe("plain string");
  });
});

describe("a path input", () => {
  async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), "hs-path-"));
  }

  it("raises file_unreadable, with the OS error as the cause, for a missing path", async () => {
    const { hs, fake } = setup();
    const missing = join(await scratch(), "missing.mp3");
    const error = await failure(hs.transcribe(missing));
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "file_unreadable" });
    expect((error as Error).cause).toMatchObject({ code: "ENOENT" });
    expect((error as Error).message).toBe(
      `${missing} cannot be read: it is missing, not a regular file or cannot be opened (Error: ENOENT: no such file or directory, stat '${missing}').`,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("names a directory as unreadable with no original error to name", async () => {
    const { hs } = setup();
    const directory = await scratch();
    const error = await failure(hs.transcribe(directory));
    expect((error as Error).message).toBe(
      `${directory} cannot be read: it is missing, not a regular file or cannot be opened.`,
    );
    expect((error as Error).cause).toBeUndefined();
  });

  it("names the original error when the first bytes of the input cannot be read", async () => {
    const { hs, fake } = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error("socket reset"));
      },
    });
    const error = await failure(hs.transcribe(stream, { size: 1000, durationSeconds: 20 }));
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "file_unreadable", status: null });
    expect((error as Error).message).toBe("The input could not be read (Error: socket reset).");
    expect(((error as Error).cause as Error).message).toBe("socket reset");
    expect(fake.calls).toHaveLength(0);
  });

  it("raises file_unreadable for a directory and for a FIFO, without opening the FIFO", async () => {
    const { hs, fake } = setup();
    const directory = await scratch();
    expect(await failure(hs.transcribe(directory))).toMatchObject({ code: "file_unreadable" });
    const fifo = join(directory, "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(await failure(hs.transcribe(fifo))).toMatchObject({
      name: "PreflightError",
      code: "file_unreadable",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("is not opened by resume() while the job is past uploading, whatever the path", async () => {
    const { hs, clock } = setup({
      jobFlow: [{ state: "processing", polls: 7 }, { state: "done" }],
    });
    const timeout = (await failure(
      driven(hs.transcribe(mp3, { waitTimeout: 60 }), clock),
    )) as WaitTimeoutError;
    const transcript = await driven(
      hs.resume(timeout.resumeToken ?? "", join(await scratch(), "missing.mp3")),
      clock,
    );
    expect(transcript.id).toBe("tr_1");
  });

  it("is checked for size before any request, and opened only for a job that is uploading", async () => {
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
    stop.abort();
    const token = ((await outcome) as AbortError).resumeToken ?? "";
    const directory = await scratch();
    const whole = join(directory, "whole.mp3");
    const short = join(directory, "short.mp3");
    await writeFile(whole, mp3);
    await writeFile(short, mp3.subarray(0, 1000));

    const before = fake.calls.length;
    const mismatch = await failure(hs.resume(token, short));
    expect(mismatch).toMatchObject({ code: "resume_file_mismatch" });
    expect(fake.calls.length).toBe(before);

    const createsBefore = fake.count("create");
    const missing = await failure(driven(hs.resume(token, join(directory, "gone.mp3")), clock));
    expect(missing).toMatchObject({ name: "PreflightError", code: "file_unreadable" });
    expect(fake.count("create")).toBe(createsBefore);

    hold = false;
    const seen: { percent: number; creates: number }[] = [];
    const transcript = await driven(
      hs.resume(token, whole, {
        onProgress: (p) => {
          if (p.stage === "uploading")
            seen.push({ percent: p.percent, creates: fake.count("create") });
        },
      }),
      clock,
    );
    expect(transcript.id).toBe("tr_1");
    // 0% once, before the replayed create goes out.
    expect(seen[0]).toEqual({ percent: 0, creates: createsBefore });
    expect(seen.filter((entry) => entry.percent === 0)).toHaveLength(1);
  });
});

describe("a source that fails to read", () => {
  it("raises source_read_failed with the key and the resume token when a stream breaks mid-upload", async () => {
    const { hs, clock, fake } = setup({ parts: 3 });
    const partSize = Math.ceil(mp3.byteLength / 3);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(mp3.subarray(0, partSize + 10));
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    });
    const error = await failure(
      driven(
        hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20, concurrency: 1 }),
        clock,
      ),
    );
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ code: "source_read_failed", status: null });
    expect((error as UploadError).message).toBe(
      `Reading the input failed at byte ${String(partSize)}, part way through the upload (Error: socket reset).`,
    );
    expect((error as UploadError).idempotencyKey).toBe(fake.creates[0]?.["idempotency_key"]);
    expect((error as UploadError).resumeToken).toBe(
      encodeResumeToken({
        jobId: "job_1",
        idempotencyKey: fake.creates[0]?.["idempotency_key"] as string,
        size: mp3.byteLength,
        durationSeconds: 20,
      }),
    );
    expect(((error as Error).cause as Error).message).toBe("socket reset");
  });
});

describe("a caller's stream is left open (spec 6.1, R88)", () => {
  /** A stream over `bytes` that counts cancel() calls; `then` follows when the bytes run out. */
  function observed(
    bytes: Uint8Array,
    then: "close" | "stall" = "close",
  ): { stream: ReadableStream<Uint8Array>; cancels: unknown[]; stalled: Promise<void> } {
    const cancels: unknown[] = [];
    let offset = 0;
    let markStalled = (): void => undefined;
    // Settles when the stream is asked for more than it has and, in "stall" mode, never answers.
    const stalled = new Promise<void>((resolve) => {
      markStalled = resolve;
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (offset >= bytes.byteLength) {
            if (then === "close") controller.close();
            else markStalled();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 4096));
          offset += 4096;
        },
        cancel(reason): void {
          cancels.push(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, cancels, stalled };
  }

  it("neither cancels nor keeps locked a stream that was uploaded in full", async () => {
    const { hs, clock } = setup();
    const { stream, cancels } = observed(mp3);
    await driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock);
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
    expect(await stream.getReader().read()).toEqual({ done: true, value: undefined });
  });

  it("leaves a stream longer than its size readable after stream_size_mismatch", async () => {
    const { hs, clock } = setup();
    const longer = new Uint8Array(mp3.byteLength + 20_000);
    longer.set(mp3);
    const { stream, cancels } = observed(longer);
    const error = await failure(
      driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock),
    );
    expect(error).toMatchObject({ code: "stream_size_mismatch", status: null });
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
    const next = await stream.getReader().read();
    expect(next.done).toBe(false);
    expect(next.value?.byteLength).toBeGreaterThan(0);
  });

  it("leaves a stream that was cut short unlocked and uncanceled", async () => {
    const { hs, clock } = setup();
    const { stream, cancels } = observed(mp3.subarray(0, mp3.byteLength - 10));
    const error = await failure(
      driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock),
    );
    expect(error).toMatchObject({ code: "stream_size_mismatch", status: null });
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
  });

  it("unlocks a stream that failed with its own error", async () => {
    const { hs, clock } = setup({ parts: 3 });
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(mp3.subarray(0, 1000));
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    });
    const error = await failure(
      driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock),
    );
    expect(error).toMatchObject({ code: "source_read_failed" });
    expect(stream.locked).toBe(false);
  });

  it("leaves the stream alone when the create is refused before any byte is read", async () => {
    const { hs, clock } = setup({
      hooks: { create: () => apiError("invalid_request", 1001, 400) },
    });
    const { stream, cancels } = observed(mp3);
    const error = await failure(
      driven(hs.transcribe(stream, { size: mp3.byteLength, durationSeconds: 20 }), clock),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
    expect((await stream.getReader().read()).done).toBe(false);
  });

  it("leaves a stream that stalled readable after the caller aborted", async () => {
    const { hs, clock } = setup();
    const { stream, cancels, stalled } = observed(mp3.subarray(0, 5000), "stall");
    const stop = new AbortController();
    const outcome = failure(
      driven(
        hs.transcribe(stream, {
          size: mp3.byteLength,
          durationSeconds: 20,
          signal: stop.signal,
        }),
        clock,
      ),
    );
    await stalled;
    stop.abort();
    expect(await outcome).toBeInstanceOf(AbortError);
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    reader.releaseLock();
  });

  it("does not cancel or lock a stream passed to resume(), on success or on a short stream", async () => {
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
    const interrupted = failure(hs.transcribe(mp3, { signal: stop.signal }));
    for (let i = 0; i < 500 && fake.count("r2") === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    stop.abort();
    const token = ((await interrupted) as AbortError).resumeToken ?? "";
    expect(token).not.toBe("");

    hold = false;
    const shortStream = observed(mp3.subarray(0, mp3.byteLength - 1));
    const mismatch = await failure(driven(hs.resume(token, shortStream.stream), clock));
    expect(mismatch).toMatchObject({ code: "stream_size_mismatch", status: null });
    expect(shortStream.cancels).toEqual([]);
    expect(shortStream.stream.locked).toBe(false);

    const good = observed(mp3);
    const transcript = await driven(hs.resume(token, good.stream), clock);
    expect(transcript.id).toBe("tr_1");
    expect(good.cancels).toEqual([]);
    expect(good.stream.locked).toBe(false);
    expect((await good.stream.getReader().read()).done).toBe(true);
  });

  it("does not cancel a stream passed to resume() when the job already left uploading", async () => {
    const { hs, clock } = setup();
    const token = encodeResumeToken({
      jobId: "job_1",
      idempotencyKey: "0123456789abcdefghij",
      size: mp3.byteLength,
      durationSeconds: 21,
    });
    const { stream, cancels } = observed(mp3);
    await driven(hs.resume(token, stream), clock);
    expect(cancels).toEqual([]);
    expect(stream.locked).toBe(false);
    expect((await stream.getReader().read()).done).toBe(false);
  });
});
