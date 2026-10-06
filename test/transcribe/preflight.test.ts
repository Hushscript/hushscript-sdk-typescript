/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import {
  DailyLimitError,
  FileLimitError,
  InsufficientBalanceError,
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
    expect((error as UnsupportedMediaError).hint).toContain(
      "ffmpeg -i input -vn -c:a libopus output.opus",
    );
    expect(f.calls).toBe(0);
  });

  it("refuses an empty file", async () => {
    const { hs } = client();
    stubFetch([{ status: 500 }]);
    expect(await refusal(hs.transcribe(new Uint8Array()))).toBeInstanceOf(UnsupportedMediaError);
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
    expect(f.calls).toBe(0);
  });

  it("refuses a duration outside 15 s to 10 hours, and a duration that is not a positive number", async () => {
    const { hs } = client();
    stubFetch([{ status: 500 }]);
    const bytes = await fixtureBytes("cbr-20s.mp3");
    expect(await refusal(hs.transcribe(bytes, { durationSeconds: 36_001 }))).toBeInstanceOf(
      FileLimitError,
    );
    const notANumber = await refusal(hs.transcribe(bytes, { durationSeconds: Number.NaN }));
    expect(notANumber).toBeInstanceOf(PreflightError);
    expect(notANumber).not.toBeInstanceOf(FileLimitError);
    expect((notANumber as PreflightError).code).toBe("invalid_option");
    expect(await refusal(hs.transcribe(bytes, { durationSeconds: 14.5 }))).toBeInstanceOf(
      FileLimitError,
    );
  });

  it("refuses unreadable duration unless durationSeconds is given", async () => {
    const { hs, clock } = client();
    fakeApi();
    const noise = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, ...new Uint8Array(3000)]);
    const error = await refusal(hs.transcribe(noise));
    expect((error as PreflightError).code).toBe("duration_unreadable");
    expect(clock.now()).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["medical without a language", { medical: true }],
    ["medical in a language it does not cover", { medical: true, language: "ja" }],
    ["more than 1000 keyterms", { keyterms: Array.from({ length: 1001 }, () => "term") }],
    ["a keyterm of 7 words", { keyterms: ["one two three four five six seven"] }],
    ["a matter code over 64 characters", { matterCode: "x".repeat(65) }],
    ["a short idempotency key", { idempotencyKey: "short" }],
    ["an idempotency key with control characters", { idempotencyKey: "abcdefghijklmnop\n" }],
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
    stubFetch([{ status: 500 }]);
    const make = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>();
    expect(await refusal(hs.transcribe(make()))).toMatchObject({ code: "invalid_option" });
    expect(await refusal(hs.transcribe(make(), { size: 10 }))).toMatchObject({
      code: "invalid_option",
    });
  });

  it("refuses with InsufficientBalanceError when the estimate exceeds the balance, with the hint filled in", async () => {
    const { hs, clock } = client();
    const fake = fakeApi({ balance: 10 });
    const error = await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3")), clock).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InsufficientBalanceError);
    const typed = error as InsufficientBalanceError;
    expect(typed.status).toBeNull();
    expect(typed.code).toBe("insufficient_balance");
    expect(typed.hint).toContain("Not enough minutes: 1 needed, 0 available.");
    expect(fake.count("account")).toBe(1);
    expect(fake.count("create")).toBe(0);
  });

  it("counts medical and translation targets in the estimate", async () => {
    const { hs, clock } = client();
    const fake = fakeApi({ balance: 70 });
    const error = await driven(
      hs.transcribe(await fixtureBytes("cbr-20s.mp3"), {
        medical: true,
        language: "en",
        translateTo: ["de", "fr"],
      }),
      clock,
    ).catch((e: unknown) => e);
    // 21 s declared x (1 + 1 + 0.5) = 53 s: fits 70, so it goes on to create.
    expect(error).not.toBeInstanceOf(InsufficientBalanceError);
    expect(fake.count("create")).toBe(1);
    const tight = fakeApi({ balance: 52 });
    const refused = await driven(
      hs.transcribe(await fixtureBytes("cbr-20s.mp3"), {
        medical: true,
        language: "en",
        translateTo: ["de", "fr"],
      }),
      clock,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InsufficientBalanceError);
    expect(tight.count("create")).toBe(0);
  });

  it("refuses with DailyLimitError past the daily limit", async () => {
    const { hs, clock } = client();
    const fake = fakeApi({ maxDaily: 3600, usedToday: 3590 });
    const error = await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3")), clock).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DailyLimitError);
    expect((error as DailyLimitError).hint).toContain("(59 of 60 min used in the last 24 h)");
    expect(fake.count("create")).toBe(0);
  });
});
