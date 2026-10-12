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
import {
  COMPILED_PROMPT_OVERHEAD,
  MAX_KEYTERMS,
  MAX_KEYTERM_CHARS,
  MAX_KEYTERM_WORDS,
  MAX_PROMPT_CHARS,
} from "../../src/transcribe/preflight";
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
    expect((error as FileLimitError).message).toMatch(
      /^The duration is \d+(\.\d+)? s; it must be 15 s to 10 hours\.$/u,
    );
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
    expect(error).toMatchObject({
      code: "unsupported_media",
      status: null,
      message: "The file is not in a supported audio format.",
    });
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
    expect((error as FileLimitError).message).toBe(
      "The file is 5000000001 bytes; the limit is 1 byte to 5000000000 bytes.",
    );
    expect(f.calls).toBe(0);
  });

  it("accepts a stream of a declared 1 byte before create", async () => {
    const { hs } = client();
    const fake = fakeApi();
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const stop = new Error("stop after preflight");
    const error = await refusal(
      hs.transcribe(stream, {
        size: 1,
        durationSeconds: 20,
        onProgress: () => {
          throw stop;
        },
      }),
    );
    expect(error).toBe(stop);
    expect(fake.calls.map((entry) => entry.route)).toEqual(["account"]);
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
      expect(error).toMatchObject({
        code: "duration_out_of_range",
        status: null,
        message: `The duration is ${String(durationSeconds)} s; it must be 15 s to 10 hours.`,
      });
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

  const medical = "medical needs language to be one of en, es, fr or de.";
  const key = "idempotencyKey must be 16 to 128 printable ASCII characters, without spaces.";
  it.each<[string, Record<string, unknown>, string]>([
    ["medical without a language", { medical: true }, medical],
    ["medical in a language it does not cover", { medical: true, language: "ja" }, medical],
    [
      "more than 1000 keyterms",
      { keyterms: Array.from({ length: 1001 }, (_, i) => `term${String(i)}`) },
      "keyterms takes at most 1000 unique terms (1001 given).",
    ],
    [
      "a keyterm of 7 words",
      { keyterms: ["one two three four five six seven"] },
      "keyterms[0] has more than 6 words.",
    ],
    [
      "a matter code over 64 characters",
      { matterCode: "x".repeat(65) },
      "matterCode is at most 64 characters.",
    ],
    ["a short idempotency key", { idempotencyKey: "x".repeat(15) }, key],
    ["a long idempotency key", { idempotencyKey: "x".repeat(129) }, key],
    ["a null idempotency key", { idempotencyKey: null }, key],
    ["a numeric idempotency key", { idempotencyKey: 42 }, key],
    ["an object idempotency key", { idempotencyKey: {} }, key],
    ["an idempotency key with control characters", { idempotencyKey: "abcdefghijklmnop\n" }, key],
    ["an idempotency key with a space", { idempotencyKey: "abcdefghijklmnop qrstuv" }, key],
    ["an idempotency key with DEL", { idempotencyKey: `${"x".repeat(15)}\u007f` }, key],
    ["an idempotency key with a non-ASCII letter", { idempotencyKey: `${"x".repeat(15)}é` }, key],
    ["concurrency 0", { concurrency: 0 }, "concurrency must be a whole number from 1 to 8."],
    [
      "a fractional concurrency",
      { concurrency: 1.5 },
      "concurrency must be a whole number from 1 to 8.",
    ],
    [
      "a negative waitTimeout",
      { waitTimeout: -1 },
      "waitTimeout must be a positive number of seconds.",
    ],
  ])("refuses %s before any request", async (_name, options, message) => {
    const { hs, clock } = client();
    const f = stubFetch([{ status: 500 }]);
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const error = await refusal(driven(hs.transcribe(bytes, options), clock));
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "invalid_option", status: null, message });
    expect(f.calls).toBe(0);
  });

  it("accepts medical for en and keyterms of six words, however they are spaced", async () => {
    const { hs, clock } = client();
    const fake = fakeApi();
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const keyterms = [
      "one two three four five six",
      " one two three four five six ",
      "one   two three four five six",
    ];
    await driven(hs.transcribe(bytes, { medical: true, language: "en", keyterms }), clock);
    expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
      medical_mode: true,
      language_code: "en",
      keyterms_prompt: keyterms.map((term) => term.trim()),
    });
  });

  describe("key term and prompt limits", () => {
    const wordsOf = (count: number): string =>
      Array.from({ length: count }, (_, i) => `w${String(i)}`).join(" ");
    const refused = async (options: Record<string, unknown>): Promise<unknown> => {
      const { hs, clock } = client();
      const f = stubFetch([{ status: 500 }]);
      const error = await refusal(
        driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3"), options), clock),
      );
      expect(f.calls).toBe(0);
      return error;
    };
    const created = async (options: Record<string, unknown>): Promise<unknown> => {
      const { hs, clock } = client();
      const fake = fakeApi();
      await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3"), options), clock);
      return fake.creates[0]?.["transcription_options"];
    };
    const compiledLength = (prompt: string, terms: string[]): number =>
      COMPILED_PROMPT_OVERHEAD +
      Array.from(prompt).length +
      terms.reduce((sum, term) => sum + Array.from(term).length + 2, 0) +
      (terms.length - 1);

    it("accepts a term of the character cap and refuses one past it, naming its index", async () => {
      expect(await created({ keyterms: ["x".repeat(MAX_KEYTERM_CHARS)] })).toEqual({
        keyterms_prompt: ["x".repeat(MAX_KEYTERM_CHARS)],
      });
      const error = await refused({ keyterms: ["ok", "x".repeat(MAX_KEYTERM_CHARS + 1)] });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        message: `keyterms[1] is longer than ${String(MAX_KEYTERM_CHARS)} characters.`,
      });
    });

    it("counts term length in code points, not UTF-16 units or bytes", async () => {
      const emoji = "\u{1F600}".repeat(MAX_KEYTERM_CHARS);
      expect(await created({ keyterms: [emoji] })).toEqual({ keyterms_prompt: [emoji] });
      const error = await refused({ keyterms: [`${emoji}\u{1F600}`] });
      expect(error).toMatchObject({
        message: `keyterms[0] is longer than ${String(MAX_KEYTERM_CHARS)} characters.`,
      });
    });

    it("accepts the word cap, splits on Unicode white space and refuses one word more", async () => {
      expect(await created({ keyterms: [wordsOf(MAX_KEYTERM_WORDS)] })).toEqual({
        keyterms_prompt: [wordsOf(MAX_KEYTERM_WORDS)],
      });
      const error = await refused({ keyterms: ["fine", wordsOf(MAX_KEYTERM_WORDS + 1)] });
      expect(error).toMatchObject({
        message: `keyterms[1] has more than ${String(MAX_KEYTERM_WORDS)} words.`,
      });
      const nel = Array.from({ length: MAX_KEYTERM_WORDS + 1 }, () => "w").join("\u0085");
      expect(await refused({ keyterms: [nel] })).toMatchObject({
        message: `keyterms[0] has more than ${String(MAX_KEYTERM_WORDS)} words.`,
      });
    });

    it("trims with Unicode white space: NEL goes, a byte order mark stays", async () => {
      expect(await created({ keyterms: ["\u0085term\u3000", "\uFEFFmark"] })).toEqual({
        keyterms_prompt: ["term", "\uFEFFmark"],
      });
    });

    it("accepts the term cap and refuses one unique term more; duplicates count once", async () => {
      const unique = Array.from({ length: MAX_KEYTERMS }, (_, i) => `term${String(i)}`);
      expect(await created({ keyterms: [...unique, "term0", " term1 "] })).toMatchObject({
        keyterms_prompt: [...unique, "term0", "term1"],
      });
      const error = await refused({ keyterms: [...unique, "extra"] });
      expect(error).toMatchObject({
        code: "invalid_option",
        message: `keyterms takes at most ${String(MAX_KEYTERMS)} unique terms (${String(MAX_KEYTERMS + 1)} given).`,
      });
    });

    it("reports the index in the caller's list when blanks come before the term", async () => {
      const error = await refused({ keyterms: ["", "  ", "x".repeat(MAX_KEYTERM_CHARS + 1)] });
      expect(error).toMatchObject({
        message: `keyterms[2] is longer than ${String(MAX_KEYTERM_CHARS)} characters.`,
      });
    });

    it("accepts a prompt of the cap and refuses one code point past it", async () => {
      expect(await created({ prompt: "p".repeat(MAX_PROMPT_CHARS) })).toEqual({
        prompt: "p".repeat(MAX_PROMPT_CHARS),
      });
      const emoji = "\u{1F600}".repeat(MAX_PROMPT_CHARS);
      expect(await created({ prompt: emoji })).toEqual({ prompt: emoji });
      const error = await refused({ prompt: "p".repeat(MAX_PROMPT_CHARS + 1) });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        message: `prompt is longer than ${String(MAX_PROMPT_CHARS)} characters.`,
      });
    });

    it("measures the prompt after trimming", async () => {
      const prompt = "p".repeat(MAX_PROMPT_CHARS);
      expect(await created({ prompt: `  ${prompt}\n` })).toEqual({ prompt });
    });

    it("holds prompt and key terms to the cap together, exactly at the boundary", async () => {
      const terms = ["alpha", "beta gamma", "\u{1F600}"];
      const base = compiledLength("", terms);
      const fits = "p".repeat(MAX_PROMPT_CHARS - base);
      expect(compiledLength(fits, terms)).toBe(MAX_PROMPT_CHARS);
      expect(await created({ prompt: fits, keyterms: terms })).toEqual({
        prompt: fits,
        keyterms_prompt: terms,
      });
      const error = await refused({ prompt: `${fits}p`, keyterms: terms });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        message: `prompt and keyterms together exceed ${String(MAX_PROMPT_CHARS)} characters (${String(MAX_PROMPT_CHARS + 1)}).`,
      });
    });

    it("counts a duplicate term once toward the compiled prompt", async () => {
      const terms = ["alpha", "beta"];
      const prompt = "p".repeat(MAX_PROMPT_CHARS - compiledLength("", terms));
      expect(await created({ prompt, keyterms: [...terms, " alpha"] })).toMatchObject({ prompt });
    });

    it("applies only the term limits when there is no prompt", async () => {
      const terms = Array.from({ length: 50 }, (_, i) => `${String(i)}${"t".repeat(120)}`);
      expect(compiledLength("", terms)).toBeGreaterThan(MAX_PROMPT_CHARS);
      expect(await created({ keyterms: terms, prompt: " \n" })).toEqual({
        keyterms_prompt: terms,
      });
    });

    it("applies only the prompt limit when there are no key terms", async () => {
      const prompt = "p".repeat(MAX_PROMPT_CHARS);
      expect(await created({ prompt, keyterms: ["", " "] })).toEqual({ prompt });
    });

    it("omits an empty term list and a blank prompt from the request", async () => {
      expect(await created({ keyterms: [], prompt: "" })).toBeUndefined();
      expect(
        await created({ keyterms: ["", "  \t"], prompt: " \u00a0\n", speakers: true }),
      ).toEqual({ speaker_detection: true });
    });
  });

  it("accepts an idempotency key that uses both ends of the printable range", async () => {
    const { hs, clock } = client();
    const fake = fakeApi();
    const idempotencyKey = `!${"x".repeat(14)}~`;
    await driven(hs.transcribe(await fixtureBytes("cbr-20s.mp3"), { idempotencyKey }), clock);
    expect(fake.creates[0]).toMatchObject({ idempotency_key: idempotencyKey });
  });

  it("refuses a stream without durationSeconds or size", async () => {
    const { hs } = client();
    const f = stubFetch([{ status: 500 }]);
    const make = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>();
    const needsSize =
      "A stream input needs size (and durationSeconds); the SDK will not buffer an unbounded stream.";
    for (const [options, message] of [
      [{}, needsSize],
      [{ size: 10 }, "A stream input needs durationSeconds and size."],
      [{ durationSeconds: 20 }, needsSize],
    ] as const) {
      const error = await refusal(hs.transcribe(make(), options));
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null, message });
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
    expect(error).toMatchObject({
      code: "daily_limit",
      status: null,
      message: "This upload would pass the daily limit (3590 of 3600 s used).",
    });
    expect((error as DailyLimitError).details).toEqual({ usedSeconds: 3590, maxSeconds: 3600 });
    expect((error as DailyLimitError).hint).toContain("(59 of 60 min used in the last 24 h)");
    expect(fake.count("create")).toBe(0);
  });
});
