import type { Client } from "openapi-fetch";
import {
  DailyLimitError,
  FileLimitError,
  HushscriptError,
  PreflightError,
  UnsupportedMediaError,
  describeError,
  hintValuesFrom,
} from "../errors.ts";
import type { paths } from "../generated/schema";
import { readAccount } from "../resources/account.ts";
import { isPathSegment } from "../shape.ts";
import { probeDuration } from "./probe.ts";
import { sniff } from "./sniff.ts";
import type { Source } from "./source.ts";
import type { TranscribeOptions } from "./types.ts";

const MAX_FILE_BYTES = 5_000_000_000;
const MIN_DURATION_SECONDS = 15;
const MAX_DURATION_SECONDS = 36_000;
export const MAX_KEYTERMS = 1000;
export const MAX_KEYTERM_WORDS = 6;
export const MAX_KEYTERM_CHARS = 128;
export const MAX_PROMPT_CHARS = 2000;
/** Whitespace-split words across the unique key terms; the server also keeps a token budget the SDK does not mirror. */
export const MAX_KEYTERM_TOTAL_WORDS = 1000;
const MAX_MATTER_CODE = 64;
/** Mirrors the API's `MEDICAL_LANGUAGES` (`transcription_options.rs`). */
const MEDICAL_LANGUAGES: readonly string[] = [
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "es",
  "fr",
  "de",
  "de_ch",
];
/** Mirrors the API's `VET_LANGUAGES`. */
const VET_LANGUAGES: readonly string[] = [
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "es",
  "fr",
  "de",
  "de_ch",
];
/** Mirrors the API's `STT37_LANGUAGES`: the languages that apply key terms and a prompt. */
const STT37_LANGUAGES: readonly string[] = [
  "af",
  "ar",
  "ca",
  "da",
  "de",
  "de_ch",
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gl",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "mr",
  "nl",
  "nn",
  "no",
  "pt",
  "ro",
  "ru",
  "sv",
  "tr",
  "ur",
  "vi",
  "zh",
];
/** The rest of the API's `SOURCE_LANGUAGES`; the server names a code in neither list itself. */
const UNIVERSAL_2_LANGUAGES: readonly string[] = [
  "am",
  "as",
  "az",
  "ba",
  "be",
  "bg",
  "bn",
  "bo",
  "br",
  "bs",
  "cs",
  "cy",
  "el",
  "eu",
  "fo",
  "gu",
  "ha",
  "haw",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "is",
  "jw",
  "ka",
  "kk",
  "km",
  "kn",
  "la",
  "lb",
  "ln",
  "lo",
  "lt",
  "lv",
  "mg",
  "mi",
  "mk",
  "ml",
  "mn",
  "ms",
  "mt",
  "my",
  "ne",
  "oc",
  "pa",
  "pl",
  "ps",
  "sa",
  "sd",
  "si",
  "sk",
  "sl",
  "sn",
  "so",
  "sq",
  "sr",
  "su",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "tk",
  "tl",
  "tt",
  "uk",
  "uz",
  "yi",
  "yo",
];
const SNIFF_BYTES = 64;

const WHITE_SPACE_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const WHITE_SPACE_RUN = /\p{White_Space}+/u;

/** Characters as the server counts them: Unicode code points, not UTF-16 units or bytes. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** Trims with Unicode White_Space, as the server does; `String.prototype.trim` differs at U+0085 and U+FEFF. */
function trimWhiteSpace(text: string): string {
  return text.replace(WHITE_SPACE_EDGES, "");
}

interface ContextOptions {
  /** Trimmed terms with blanks dropped, in order; duplicates stay. */
  keyterms: string[];
  /** The position in the caller's list of each entry in `keyterms`. */
  keytermIndexes: number[];
  /** The trimmed prompt, or undefined when it is absent or blank. */
  prompt: string | undefined;
}

/** What is sent for key terms and prompt: an empty list or a blank prompt means the option is off. */
export function normalizeContext(options: TranscribeOptions): ContextOptions {
  const keyterms: string[] = [];
  const keytermIndexes: number[] = [];
  (options.keyterms ?? []).forEach((term, index) => {
    const trimmed = trimWhiteSpace(term);
    if (trimmed !== "") {
      keyterms.push(trimmed);
      keytermIndexes.push(index);
    }
  });
  const prompt = trimWhiteSpace(options.prompt ?? "");
  return { keyterms, keytermIndexes, prompt: prompt === "" ? undefined : prompt };
}

/** Typed key terms or a prompt do nothing in a language the API does not serve with its newest model, so the API refuses them. */
function checkContextLanguage(
  options: TranscribeOptions,
  keyterms: string[],
  prompt: string | undefined,
): void {
  // Stryker disable next-line StringLiteral: the default only has to be a string that is not a listed language
  const language = (options.language ?? "").trim().toLowerCase();
  if (!UNIVERSAL_2_LANGUAGES.includes(language)) return;
  const option = keyterms.length > 0 ? "keyterms" : prompt === undefined ? undefined : "prompt";
  if (option === undefined) return;
  throw invalidOption(
    `${option} does not work for language "${language}"; it needs language to be one of ${STT37_LANGUAGES.join(", ")}.`,
  );
}

function checkContext(options: TranscribeOptions): void {
  const { keyterms, keytermIndexes, prompt } = normalizeContext(options);
  checkContextLanguage(options, keyterms, prompt);
  const unique = new Set(keyterms);
  if (unique.size > MAX_KEYTERMS) {
    throw invalidOption(
      `keyterms takes at most ${String(MAX_KEYTERMS)} unique terms (${String(unique.size)} given).`,
    );
  }
  keyterms.forEach((term, position) => {
    const name = `keyterms[${String(keytermIndexes[position])}]`;
    if (codePoints(term) > MAX_KEYTERM_CHARS) {
      throw invalidOption(`${name} is longer than ${String(MAX_KEYTERM_CHARS)} characters.`);
    }
    if (term.split(WHITE_SPACE_RUN).length > MAX_KEYTERM_WORDS) {
      throw invalidOption(`${name} has more than ${String(MAX_KEYTERM_WORDS)} words.`);
    }
  });
  let totalWords = 0;
  for (const term of unique) totalWords += term.split(WHITE_SPACE_RUN).length;
  if (totalWords > MAX_KEYTERM_TOTAL_WORDS) {
    throw invalidOption(
      `keyterms takes at most ${String(MAX_KEYTERM_TOTAL_WORDS)} words in total (${String(totalWords)} given).`,
    );
  }
  if (prompt !== undefined && codePoints(prompt) > MAX_PROMPT_CHARS) {
    throw invalidOption(`prompt is longer than ${String(MAX_PROMPT_CHARS)} characters.`);
  }
}

export function invalidOption(message: string): PreflightError {
  return new PreflightError({ code: "invalid_option", message });
}

/** An id a caller passed that becomes a request path segment; one that cannot be is refused before any request. */
export function checkPathId(id: unknown, name: string): string {
  if (!isPathSegment(id)) {
    throw invalidOption(
      `${name} must be a non-empty string that is not "." or "..", with no lone surrogate.`,
    );
  }
  return id;
}

/** A supplied duration that is not a finite positive number is an invalid option, not an out-of-range file. */
export function checkDurationOption(seconds: number | undefined): void {
  if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
    throw invalidOption("durationSeconds must be a finite number of seconds, above 0.");
  }
}

/** Uploads accept 16 to 128 bytes of printable ASCII, without the space (0x21 to 0x7E). */
function checkIdempotencyKey(key: string): void {
  let printable = typeof key === "string" && key.length >= 16 && key.length <= 128;
  for (let i = 0; printable && i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    printable = code >= 0x21 && code <= 0x7e;
  }
  if (!printable) {
    throw invalidOption(
      "idempotencyKey must be 16 to 128 printable ASCII characters, without spaces.",
    );
  }
}

function languageRule(option: string, languages: readonly string[]): string {
  return languages.length === 0
    ? `${option} is not available for any language yet.`
    : `${option} needs language to be one of ${languages.join(", ")}.`;
}

function checkOptions(options: TranscribeOptions): void {
  if (options.medical === true && options.vet === true) {
    throw invalidOption("medical and vet cannot be combined.");
  }
  // Stryker disable next-line StringLiteral: the default only has to be a string that is not a medical language
  if (options.medical === true && !MEDICAL_LANGUAGES.includes(options.language ?? "")) {
    throw invalidOption(languageRule("medical", MEDICAL_LANGUAGES));
  }
  // Stryker disable next-line StringLiteral: the default only has to be a string that is not a vet language
  if (options.vet === true && !VET_LANGUAGES.includes(options.language ?? "")) {
    throw invalidOption(languageRule("vet", VET_LANGUAGES));
  }
  checkContext(options);
  // Stryker disable next-line StringLiteral: the default only has to be under the length limit
  if ((options.matterCode ?? "").length > MAX_MATTER_CODE) {
    throw invalidOption(`matterCode is at most ${String(MAX_MATTER_CODE)} characters.`);
  }
  if (options.idempotencyKey !== undefined) checkIdempotencyKey(options.idempotencyKey);
}

/** The first bytes of the input; a read that fails is an unreadable input, not a plain error. */
async function readHead(source: Source, signal: AbortSignal): Promise<Uint8Array> {
  try {
    return await source.head(SNIFF_BYTES, signal);
  } catch (error) {
    if (error instanceof HushscriptError) throw error;
    throw new PreflightError({
      code: "file_unreadable",
      message: `The input could not be read (${describeError(error)}).`,
      cause: error,
    });
  }
}

/**
 * Everything the SDK can refuse before a hold is placed, in a fixed order. Returns
 * the duration to declare: the probed or supplied seconds, rounded up.
 */
export async function preflight(
  source: Source,
  options: TranscribeOptions,
  api: Client<paths>,
  signal: AbortSignal,
): Promise<number> {
  if (sniff(await readHead(source, signal)) === null) {
    throw new UnsupportedMediaError({
      code: "unsupported_media",
      message: "The file is not in a supported audio format.",
    });
  }
  // No input reaches this with 0 bytes: openSource refuses a stream size below 1, and any other
  // input's head holds at most its size, while sniff needs at least 2 bytes.
  if (source.size > MAX_FILE_BYTES) {
    throw new FileLimitError({
      code: "size_out_of_range",
      message: `The file is ${String(source.size)} bytes; the limit is 1 byte to ${String(MAX_FILE_BYTES)} bytes.`,
    });
  }
  const seconds = options.durationSeconds ?? (await probeDuration(source, signal));
  if (seconds < MIN_DURATION_SECONDS || Math.ceil(seconds) > MAX_DURATION_SECONDS) {
    throw new FileLimitError({
      code: "duration_out_of_range",
      message: `The duration is ${String(seconds)} s; it must be 15 s to 10 hours.`,
    });
  }
  checkOptions(options);
  const declared = Math.ceil(seconds);

  const data = await readAccount(api, signal);
  const { used_today_seconds: used, max_daily_seconds: max } = data.limits;
  if (used + declared > max) {
    throw new DailyLimitError({
      code: "daily_limit",
      message: `This upload would pass the daily limit (${String(used)} of ${String(max)} s used).`,
      details: { usedSeconds: used, maxSeconds: max },
      hintValues: hintValuesFrom({ usedSeconds: used, maxSeconds: max }),
    });
  }
  return declared;
}
