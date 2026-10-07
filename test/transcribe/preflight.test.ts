/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import {
  DailyLimitError,
  FileLimitError,
  PreflightError,
  UnsupportedMediaError,
} from "../../src/errors";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch } from "../helpers";
import { driven, fakeApi } from "./fakeapi";
import { fixtureBytes, fixturePath } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): { hs: Hushscript; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock({ manual: true });
  return {
    hs: new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS }),
    clock,
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e: unknown) => e);
}

describe("preflight", () => {
  it("refuses a 10 s file with FileLimitError and makes no request", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const error = await refusal(hs.transcribe(await fixturePath("short-10s.mp3")));
    expect(error).toBeInstanceOf(FileLimitError);
    expect((error as FileLimitError).code).toBe("duration_out_of_range");
    expect((error as FileLimitError).status).toBeNull();
    expect((error as FileLimitError).hint).toBe(
      "Files must be between 15 seconds and 10 hours long.",
    );
    expect(f.calls).toBe(0);
  });

  it("refuses a renamed WebM by its magic bytes, with the ffmpeg hint, and makes no request", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const error = await refusal(hs.transcribe(await fixturePath("webm-renamed.mp3")));
    expect(error).toBeInstanceOf(UnsupportedMediaError);
    expect(error).toMatchObject({ code: "unsupported_media", status: null });
    expect((error as UnsupportedMediaError).hint).toContain(
      "ffmpeg -i input -vn -c:a libopus output.opus",
    );
    expect(f.calls).toBe(0);
  });

  it("refuses an empty file", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const error = await refusal(hs.transcribe(new Uint8Array()));
    expect(error).toBeInstanceOf(UnsupportedMediaError);
    expect(error).toMatchObject({ code: "unsupported_media", status: null });
    expect(f.calls).toBe(0);
  });

  it("refuses a file over 5 GB by its declared size", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const huge = new Blob([bytes]);
    Object.defineProperty(huge, "size", { value: 5_000_000_001 });
    const error = await refusal(hs.transcribe(huge, { durationSeconds: 60 }));
    expect(error).toBeInstanceOf(FileLimitError);
    expect((error as FileLimitError).code).toBe("size_out_of_range");
    expect((error as FileLimitError).status).toBeNull();
    expect(f.calls).toBe(0);
  });

  it.each([14.5, 36_000.5, 36_001])(
    "refuses duration %s outside the file limits",
    async (durationSeconds) => {
      const { hs } = client();
      const f = stubFetch([{ status: 500 }]);
      const error = await refusal(
        hs.transcribe(await fixtureBytes("cbr-20s.mp3"), { durationSeconds }),
      );
      expect(error).toBeInstanceOf(FileLimitError);
      expect(error).toMatchObject({ code: "duration_out_of_range", status: null });
      expect(f.calls).toBe(0);
    },
  );

  it("refuses unreadable duration unless durationSeconds is given", async () => {
    const { hs, clock } = client();
    const fake = fakeApi();
    const noise = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, ...new Uint8Array(3000)]);
    const error = await refusal(hs.transcribe(noise));
    expect(error).toBeInstanceOf(UnsupportedMediaError);
    expect(error).toMatchObject({ code: "duration_unreadable", status: null });
    expect(fake.calls).toHaveLength(0);
    await driven(hs.transcribe(noise, { durationSeconds: 20 }), clock);
    expect(fake.creates[0]).toMatchObject({ duration_seconds: 20 });
  });

  it.each<[string, Record<string, unknown>]>([
    ["medical without a language", { medical: true }],
    ["medical in a language it does not cover", { medical: true, language: "ja" }],
    ["more than 1000 keyterms", { keyterms: Array.from({ length: 1001 }, () => "term") }],
    ["a keyterm of 7 words", { keyterms: ["one two three four five six seven"] }],
    ["a matter code over 64 characters", { matterCode: "x".repeat(65) }],
    ["a short idempotency key", { idempotencyKey: "x".repeat(15) }],
    ["a long idempotency key", { idempotencyKey: "x".repeat(129) }],
    ["a null idempotency key", { idempotencyKey: null }],
    ["a numeric idempotency key", { idempotencyKey: 42 }],
    ["an object idempotency key", { idempotencyKey: {} }],
    ["an idempotency key with control characters", { idempotencyKey: "abcdefghijklmnop\n" }],
    ["an idempotency key with a space", { idempotencyKey: "abcdefghijklmnop qrstuv" }],
    ["concurrency 0", { concurrency: 0 }],
    ["a fractional concurrency", { concurrency: 1.5 }],
    ["a negative waitTimeout", { waitTimeout: -1 }],
  ])("refuses %s before any request", async (_name, options) => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const error = await refusal(hs.transcribe(bytes, options));
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).code).toBe("invalid_option");
    expect((error as PreflightError).status).toBeNull();
    expect(f.calls).toBe(0);
  });

  it("accepts medical for en and keyterms of six words", async () => {
    const { hs, clock } = client();
    const fake = fakeApi();
    const bytes = await fixtureBytes("cbr-20s.mp3");
    await driven(
      hs.transcribe(bytes, {
        medical: true,
        language: "en",
        keyterms: ["one two three four five six"],
      }),
      clock,
    );
    expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
      medical_mode: true,
      language_code: "en",
    });
  });

  it("refuses a stream without durationSeconds or size", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const make = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>();
    for (const options of [{}, { size: 10 }, { durationSeconds: 20 }]) {
      const error = await refusal(hs.transcribe(make(), options));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(f.calls).toBe(0);
    }
  });

  it("accepts exactly 5 GB before create", async () => {
    const { hs } = client();
    const fake = fakeApi();
    const blob = new Blob([await fixtureBytes("cbr-20s.mp3")]);
    Object.defineProperty(blob, "size", { value: 5_000_000_000 });
    const stop = new Error("stop after preflight");
    const error = await refusal(
      hs.transcribe(blob, {
        durationSeconds: 20,
        onProgress: () => {
          throw stop;
        },
      }),
    );
    expect(error).toBe(stop);
    expect(fake.calls.map((entry) => entry.route)).toEqual(["account"]);
  });

  it.each([15, 36_000])(
    "accepts duration boundary %s and an exactly full daily limit",
    async (durationSeconds) => {
      const { hs, clock } = client();
      const fake = fakeApi({ maxDaily: durationSeconds + 10, usedToday: 10 });
      await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3"), { durationSeconds }), clock);
      expect(fake.creates[0]).toMatchObject({ duration_seconds: durationSeconds });
      expect(fake.count("create")).toBe(1);
    },
  );

  it.each([16, 128])(
    "accepts key length %s with maximum keyterms and matter code and concurrency 1",
    async (length) => {
      const { hs, clock } = client();
      const fake = fakeApi();
      const idempotencyKey = "x".repeat(length);
      const keyterms = Array.from({ length: 1000 }, () => "term");
      const matterCode = "m".repeat(64);
      await driven(
        hs.transcribe(await fixtureBytes("cbr-20s.mp3"), {
          idempotencyKey,
          keyterms,
          matterCode,
          concurrency: 1,
        }),
        clock,
      );
      expect(fake.creates[0]).toMatchObject({
        idempotency_key: idempotencyKey,
        matter_code: matterCode,
        transcription_options: { keyterms_prompt: keyterms },
      });
    },
  );

  it("goes on to create with a balance of 0: the server's 402 at create is the authority", async () => {
    const { hs, clock } = client();
    const fake = fakeApi({ balance: 0 });
    await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3")), clock);
    expect(fake.count("account")).toBe(1);
    expect(fake.count("create")).toBe(1);
  });

  it("refuses with DailyLimitError past the daily limit", async () => {
    const { hs, clock } = client();
    const fake = fakeApi({ maxDaily: 3600, usedToday: 3590 });
    const error = await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3")), clock).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DailyLimitError);
    expect(error).toMatchObject({ code: "daily_limit", status: null });
    expect((error as DailyLimitError).hint).toContain("(59 of 60 min used in the last 24 h)");
    expect(fake.count("create")).toBe(0);
  });
});
