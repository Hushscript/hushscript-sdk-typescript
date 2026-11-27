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
  MAX_KEYTERMS,
  MAX_KEYTERM_CHARS,
  MAX_KEYTERM_TOTAL_WORDS,
  MAX_KEYTERM_WORDS,
  MAX_PROMPT_CHARS,
  MAX_TRANSLATION_TARGETS,
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

// Restated on purpose, not derived: these mirror backend/src/transcription_options.rs, and a drift in the
// SDK's constants must fail here.
describe("context limits", () => {
  it("equal the backend's values", () => {
    expect(MAX_KEYTERMS).toBe(1000);
    expect(MAX_KEYTERM_WORDS).toBe(6);
    expect(MAX_KEYTERM_CHARS).toBe(128);
    expect(MAX_PROMPT_CHARS).toBe(2000);
    expect(MAX_KEYTERM_TOTAL_WORDS).toBe(1000);
    expect(MAX_TRANSLATION_TARGETS).toBe(15);
  });
});

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

  const medical = "medical needs language to be one of en, en_au, en_uk, en_us, es, fr, de, de_ch.";
  const vet = "vet needs language to be one of en, en_au, en_uk, en_us, es, fr, de, de_ch.";
  const domains = "medical and vet cannot be combined.";
  const key = "idempotencyKey must be 16 to 128 printable ASCII characters, without spaces.";
  it.each<[string, Record<string, unknown>, string]>([
    ["medical without a language", { medical: true }, medical],
    ["medical in a language it does not cover", { medical: true, language: "ja" }, medical],
    ["medical in a regional variant it does not cover", { medical: true, language: "pt" }, medical],
    ["vet without a language", { vet: true }, vet],
    ["vet in a language it does not cover", { vet: true, language: "ja" }, vet],
    ["medical and vet together", { medical: true, vet: true, language: "en" }, domains],
    ["medical and vet together without a language", { medical: true, vet: true }, domains],
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

  it.each(["en", "en_au", "en_uk", "en_us", "es", "fr", "de", "de_ch"])(
    "accepts medical for %s",
    async (language) => {
      const { hs, clock } = client();
      const fake = fakeApi();
      const bytes = await fixtureBytes("cbr-20s.mp3");
      await driven(hs.transcribe(bytes, { medical: true, language }), clock);
      expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
        medical_mode: true,
        language_code: language,
      });
    },
  );

  it.each(["en", "en_au", "en_uk", "en_us", "es", "fr", "de", "de_ch"])(
    "accepts vet for %s",
    async (language) => {
      const { hs, clock } = client();
      const fake = fakeApi();
      const bytes = await fixtureBytes("cbr-20s.mp3");
      await driven(hs.transcribe(bytes, { vet: true, language }), clock);
      expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
        vet_mode: true,
        language_code: language,
      });
    },
  );

  it("does not refuse medical or vet when they are set to false", async () => {
    const { hs, clock } = client();
    const fake = fakeApi();
    const bytes = await fixtureBytes("cbr-20s.mp3");
    await driven(hs.transcribe(bytes, { medical: false, vet: false, language: "ja" }), clock);
    expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
      medical_mode: false,
      vet_mode: false,
    });
  });

  describe("key terms and prompt by language", () => {
    // Restated on purpose: these mirror backend/src/provider_language_features.rs.
    const stt37 = [
      ...["af", "ar", "ca", "da", "de", "de_ch", "en", "en_au", "en_uk", "en_us", "es"],
      ...["et", "fa", "fi", "fr", "gl", "he", "hi", "it", "ja", "ko", "mr", "nl", "nn", "no"],
      ...["pt", "ro", "ru", "sv", "tr", "ur", "vi", "zh"],
    ];
    const universal2 = [
      ...["am", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "cs", "cy", "el", "eu"],
      ...["fo", "gu", "ha", "haw", "hr", "ht", "hu", "hy", "id", "is", "jw", "ka", "kk", "km"],
      ...["kn", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "ms", "mt"],
      ...["my", "ne", "oc", "pa", "pl", "ps", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq"],
      ...["sr", "su", "sw", "ta", "te", "tg", "th", "tk", "tl", "tt", "uk", "uz", "yi", "yo"],
    ];
    const supported = stt37.join(", ");
    const message = (option: string, language: string): string =>
      `${option} does not work for language "${language}"; it needs language to be one of ${supported}.`;

    async function refused(options: Record<string, unknown>): Promise<unknown> {
      const { hs, clock } = client();
      const f = stubFetch([{ status: 500 }]);
      const bytes = await fixtureBytes("cbr-20s.mp3");
      const error = await refusal(driven(hs.transcribe(bytes, options), clock));
      expect(f.calls).toBe(0);
      return error;
    }

    async function created(options: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { hs, clock } = client();
      const fake = fakeApi();
      const bytes = await fixtureBytes("cbr-20s.mp3");
      await driven(hs.transcribe(bytes, options), clock);
      return (fake.creates[0]?.["transcription_options"] ?? {}) as Record<string, unknown>;
    }

    it("covers the 103 source languages", () => {
      expect(new Set([...stt37, ...universal2]).size).toBe(103);
      expect(stt37).toHaveLength(33);
    });

    it.each(universal2)("refuses keyterms for %s", async (language) => {
      const error = await refused({ keyterms: ["Hushscript"], language });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        status: null,
        message: message("keyterms", language),
      });
    });

    it.each(universal2)("refuses a prompt for %s", async (language) => {
      const error = await refused({ prompt: "Names.", language });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        status: null,
        message: message("prompt", language),
      });
    });

    it.each(stt37)("accepts keyterms and a prompt for %s", async (language) => {
      expect(await created({ keyterms: ["Hushscript"], prompt: "Names.", language })).toMatchObject(
        {
          language_code: language,
          keyterms_prompt: ["Hushscript"],
          prompt: "Names.",
        },
      );
    });

    it("names the key terms when both are given, and normalizes the language", async () => {
      const error = await refused({ keyterms: ["x"], prompt: "Names.", language: " PL " });
      expect(error).toMatchObject({ code: "invalid_option", message: message("keyterms", "pl") });
    });

    it("refuses a language code padded with U+0085, as the server does", async () => {
      const error = await refused({ keyterms: ["x"], language: "pl\u0085" });
      expect(error).toMatchObject({ code: "invalid_option", message: message("keyterms", "pl") });
    });

    it("refuses a prompt next to blank key terms", async () => {
      const error = await refused({ keyterms: [" ", ""], prompt: "Names.", language: "th" });
      expect(error).toMatchObject({ code: "invalid_option", message: message("prompt", "th") });
    });

    it.each<[string, Record<string, unknown>]>([
      ["blank key terms and a blank prompt", { keyterms: [" ", ""], prompt: "  " }],
      ["an empty key term list", { keyterms: [] }],
      ["no context, with keepDisfluencies", { keepDisfluencies: true }],
    ])("does not refuse %s in a language without context", async (_name, options) => {
      expect(await created({ ...options, language: "pl" })).toMatchObject({ language_code: "pl" });
    });

    it("does not refuse key terms or a prompt under auto-detect", async () => {
      expect(await created({ keyterms: ["Hushscript"], prompt: "Names." })).toMatchObject({
        keyterms_prompt: ["Hushscript"],
        prompt: "Names.",
      });
    });

    it("leaves a code it does not list to the server", async () => {
      expect(await created({ keyterms: ["Hushscript"], language: "xx" })).toMatchObject({
        language_code: "xx",
        keyterms_prompt: ["Hushscript"],
      });
    });
  });

  it.each([
    ["medical", { medical: true }],
    ["vet", { vet: true }],
  ])("reads the language for %s as the server does: trimmed and lowercased", async (_name, on) => {
    const { hs, clock } = client();
    const fake = fakeApi();
    await driven(
      hs.transcribe(await fixtureBytes("cbr-20s.mp3"), { ...on, language: " EN_US\u0085" }),
      clock,
    );
    expect(fake.creates[0]?.["transcription_options"]).toMatchObject({
      language_code: " EN_US\u0085",
    });
  });

  describe("translation targets", () => {
    const codes = "es fr de it pt nl af sq am ar hy as az ba eu be".split(" ");
    const targets = (count: number): string[] => codes.slice(0, count);
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

    it("accepts the cap and refuses one distinct target more, before any request", async () => {
      expect(await created({ translateTo: targets(MAX_TRANSLATION_TARGETS) })).toEqual({
        translation_targets: targets(MAX_TRANSLATION_TARGETS),
      });
      const error = await refused({ translateTo: targets(MAX_TRANSLATION_TARGETS + 1) });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        status: null,
        message: `translateTo takes at most ${String(MAX_TRANSLATION_TARGETS)} distinct languages (${String(MAX_TRANSLATION_TARGETS + 1)} given).`,
      });
    });

    it("counts a target once however it is cased, padded or repeated, and ignores blanks", async () => {
      const padded = [
        ...targets(MAX_TRANSLATION_TARGETS).map((code) => code.toUpperCase()),
        " ES ",
        "es",
        "",
        "  ",
      ];
      expect(await created({ translateTo: padded })).toMatchObject({ translation_targets: padded });
    });

    it("sends speaker_detection as given and does not force it on", async () => {
      expect(await created({ translateTo: ["es"], speakers: false })).toEqual({
        speaker_detection: false,
        translation_targets: ["es"],
      });
      expect(await created({ translateTo: ["es"] })).toEqual({ translation_targets: ["es"] });
      expect(await created({ translateTo: ["es"], speakers: true })).toEqual({
        speaker_detection: true,
        translation_targets: ["es"],
      });
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
    const phrases = (prefix: string, terms: number, wordsEach: number): string[] =>
      Array.from({ length: terms }, (_, t) =>
        Array.from({ length: wordsEach }, (_, w) => `${prefix}${String(t)}x${String(w)}`).join(" "),
      );

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

    it("holds the key terms to the word cap in total, exactly at the boundary", async () => {
      const terms = phrases("a", MAX_KEYTERM_TOTAL_WORDS / 2, 2);
      expect(await created({ keyterms: terms })).toEqual({ keyterms_prompt: terms });
      const error = await refused({ keyterms: [...terms, "extra"] });
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({
        code: "invalid_option",
        message: `keyterms takes at most ${String(MAX_KEYTERM_TOTAL_WORDS)} words in total (${String(MAX_KEYTERM_TOTAL_WORDS + 1)} given).`,
      });
    });

    it("splits the word total on Unicode white space and counts a duplicate term once", async () => {
      const terms = phrases("a", MAX_KEYTERM_TOTAL_WORDS / 2, 2);
      expect(await created({ keyterms: [...terms, ` ${terms[0] ?? ""}`] })).toMatchObject({
        keyterms_prompt: [...terms, terms[0]],
      });
      const nel = terms.map((term) => term.replace(" ", "\u0085"));
      expect(await created({ keyterms: nel })).toEqual({ keyterms_prompt: nel });
      expect(await refused({ keyterms: [...nel, "a\u3000b"] })).toMatchObject({
        message: expect.stringContaining("words in total (1002 given)") as unknown,
      });
    });

    it("does not count the prompt toward the key-term words or the key terms toward the prompt", async () => {
      const terms = phrases("a", MAX_KEYTERM_TOTAL_WORDS / 2, 2);
      const prompt = "p ".repeat(MAX_PROMPT_CHARS / 2).trim();
      expect(await created({ keyterms: terms, prompt })).toEqual({
        keyterms_prompt: terms,
        prompt,
      });
      const emoji = "\u{1F600}".repeat(MAX_PROMPT_CHARS);
      expect(await created({ keyterms: ["alpha"], prompt: emoji })).toEqual({
        keyterms_prompt: ["alpha"],
        prompt: emoji,
      });
    });

    it("applies only the term limits when there is no prompt", async () => {
      const terms = Array.from({ length: 50 }, (_, i) => `${String(i)}${"t".repeat(120)}`);
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
