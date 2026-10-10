import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import { ApiError, HushscriptError, UploadError } from "../../src/errors";
import { encodeResumeToken } from "../../src/transcribe/resume";
import { BASE, JOB_OPTIONS, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock } from "../helpers";
import { driven, fakeApi, type FakeConfig } from "./fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Twenty bytes the sniffer takes for an mp3. */
const MEDIA = Uint8Array.from([0x49, 0x44, 0x33, ...Array.from({ length: 17 }, () => 0)]);
const KEY = "0123456789abcdefghij";
const RESUME_TOKEN = encodeResumeToken({
  jobId: "job_1",
  idempotencyKey: KEY,
  size: MEDIA.byteLength,
  durationSeconds: 20,
});
/** Not the 200 the API sends, so a test fails if the status is made up instead of read. */
const ANSWERED = 201;

const WRONG = { not: "that" };
const CREATE = {
  job_id: "job_1",
  state: "uploading",
  upload: {
    part_size_bytes: 7,
    total_parts: 3,
    part_urls: [{ n: 1, url: `${BASE}/__r2/job_1/1` }],
    next_part_number: null,
  },
};
const PAGE = { part_urls: [{ n: 17, url: `${BASE}/__r2/job_1/17` }], next_part_number: null };
const COMPLETE = { state: "queued" };
const jobBody = (state: string): Record<string, unknown> => ({
  id: "job_1",
  state,
  mode: "standard",
  declared_seconds: 21,
  verified_seconds: 20,
  actual_seconds: null,
  billable_seconds: 0,
  error: null,
  failure_kind: null,
  retry_of: null,
  created_at: 1,
  transcript_id: state === "done" ? "tr_1" : null,
  private_result_expires_at: null,
  private_result_available: false,
  options: JOB_OPTIONS,
});
const TRANSCRIPT = {
  id: "tr_1",
  title: "T",
  language_detected: "en",
  duration_seconds: 20,
  speaker_names: {},
  tags: [],
  created_at: 1,
  updated_at: 1,
  auto_delete_at: null,
  edited: false,
  body: {
    version: 1,
    original: { utterances: [{ speaker: "A", start_ms: 0, end_ms: 1000, text: "hi" }] },
    translations: {},
  },
};

/** The two bad answers every call is tried with: no fields at all, and one field of the wrong type. */
function bad(valid: Record<string, unknown>, field: string): [string, unknown][] {
  return [
    ["an empty object", {}],
    [`a wrong-typed ${field}`, { ...valid, [field]: WRONG }],
  ];
}

function setup(config: FakeConfig): { hs: Hushscript; run: <T>(call: Promise<T>) => Promise<T> } {
  const clock = fakeClock({ manual: true });
  fakeApi(config);
  const hs = new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
  return { hs, run: (call) => driven(call, clock) };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

function answered(body: unknown): () => Response {
  return () => Response.json(body, { status: ANSWERED });
}

function expectBadResponse(error: unknown): void {
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "bad_response", status: ANSWERED, numericCode: null });
}

describe("a 2xx answer that does not fit its shape, at each call site that reads one", () => {
  describe.each(bad(CREATE, "job_id"))("when the create answers %s", (_n, body) => {
    it("raises bad_response with the key the create was sent with, and no token yet", async () => {
      const { hs, run } = setup({ hooks: { create: answered(body) } });
      const error = await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 })));
      expectBadResponse(error);
      expect((error as Error).message).toMatch(/^POST \/v1\/uploads answered with a body/);
      expect((error as HushscriptError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as HushscriptError).resumeToken).toBeNull();
    });
  });

  it.each([
    ["a part size of zero", { ...CREATE, upload: { ...CREATE.upload, part_size_bytes: 0 } }],
    [
      "a part size above 32 MiB",
      { ...CREATE, upload: { ...CREATE.upload, part_size_bytes: 33_554_433 } },
    ],
    ["a part count of zero", { ...CREATE, upload: { ...CREATE.upload, total_parts: 0 } }],
    ["a fractional part count", { ...CREATE, upload: { ...CREATE.upload, total_parts: 2.5 } }],
  ])("raises bad_response when the create answers %s", async (_name, body) => {
    const { hs, run } = setup({ hooks: { create: answered(body) } });
    expectBadResponse(await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 }))));
  });

  it.each([
    ["a missing part_urls", { ...CREATE.upload, part_urls: undefined }],
    ["a string part_urls", { ...CREATE.upload, part_urls: "none" }],
    ["a null row", { ...CREATE.upload, part_urls: [null] }],
    ["a row without a url", { ...CREATE.upload, part_urls: [{ n: 1 }] }],
  ])("raises bad_response when the create answers %s", async (_name, upload) => {
    const { hs, run } = setup({ hooks: { create: answered({ ...CREATE, upload }) } });
    expectBadResponse(await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 }))));
  });

  describe.each(bad(PAGE, "part_urls"))("when a part-urls page answers %s", (_n, body) => {
    it("is the cause of parts_exhausted, carrying the key and the token", async () => {
      const { hs, run } = setup({ parts: 20, hooks: { partUrls: answered(body) } });
      const error = await failure(
        run(hs.transcribe(MEDIA, { durationSeconds: 20, concurrency: 1 })),
      );
      expect(error).toBeInstanceOf(UploadError);
      expect(error).toMatchObject({ code: "parts_exhausted" });
      // The cause is the redacted copy an error carries, which keeps the code and not the status.
      expect((error as UploadError).cause).toMatchObject({
        name: "ApiError",
        code: "bad_response",
      });
      expect(((error as UploadError).cause as Error).message).toMatch(
        /^GET \/v1\/uploads\/\{job\}\/part-urls answered with a body the SDK cannot use/,
      );
      expect((error as UploadError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as UploadError).resumeToken).toBeTruthy();
    });
  });

  describe.each(bad(COMPLETE, "state"))("when the complete answers %s", (_n, body) => {
    it("raises bad_response with the key and the token", async () => {
      const { hs, run } = setup({ hooks: { complete: answered(body) } });
      const error = await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 })));
      expectBadResponse(error);
      expect((error as Error).message).toMatch(
        /^POST \/v1\/uploads\/\{job\}\/complete answered with a body/,
      );
      expect((error as HushscriptError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as HushscriptError).resumeToken).toBeTruthy();
    });
  });

  describe.each(bad(jobBody("done"), "state"))("when a job read answers %s", (_n, body) => {
    it.each([
      ["polling after a complete that says queued", "queued"],
      ["the single read after a complete that says done", "done"],
    ])("raises bad_response with the key and the token, %s", async (_when, completeState) => {
      const { hs, run } = setup({ completeState, hooks: { job: answered(body) } });
      const error = await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 })));
      expectBadResponse(error);
      expect((error as HushscriptError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as HushscriptError).resumeToken).toBeTruthy();
    });

    it("raises bad_response from resume(), with the token's key and the token", async () => {
      const { hs, run } = setup({ hooks: { job: answered(body) } });
      const error = await failure(run(hs.resume(RESUME_TOKEN)));
      expectBadResponse(error);
      expect((error as HushscriptError).idempotencyKey).toBe(KEY);
      expect((error as HushscriptError).resumeToken).toBe(RESUME_TOKEN);
    });

    it("raises bad_response from jobs.wait, with no key and no token", async () => {
      const { hs, run } = setup({ hooks: { job: answered(body) } });
      const error = await failure(run(hs.jobs.wait("job_1")));
      expectBadResponse(error);
      expect((error as HushscriptError).idempotencyKey).toBeNull();
      expect((error as HushscriptError).resumeToken).toBeNull();
    });
  });

  describe.each(bad(CREATE, "state"))("when the replayed create answers %s", (_n, body) => {
    it("raises bad_response with the token's key and the token", async () => {
      const { hs, run } = setup({
        hooks: { job: answered(jobBody("uploading")), create: answered(body) },
      });
      const error = await failure(run(hs.resume(RESUME_TOKEN, MEDIA)));
      expectBadResponse(error);
      expect((error as Error).message).toMatch(/^POST \/v1\/uploads answered with a body/);
      expect((error as HushscriptError).idempotencyKey).toBe(KEY);
      expect((error as HushscriptError).resumeToken).toBe(RESUME_TOKEN);
    });
  });

  describe.each(bad(TRANSCRIPT, "title"))("when the transcript fetch answers %s", (_n, body) => {
    it("raises bad_response with the key and the token", async () => {
      const { hs, run } = setup({ hooks: { transcript: answered(body) } });
      const error = await failure(run(hs.transcribe(MEDIA, { durationSeconds: 20 })));
      expectBadResponse(error);
      expect((error as HushscriptError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as HushscriptError).resumeToken).toBeTruthy();
    });
  });
});
