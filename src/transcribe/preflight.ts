import type { Client } from "openapi-fetch";
import {
  DailyLimitError,
  FileLimitError,
  HushscriptError,
  PreflightError,
  UnsupportedMediaError,
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
const MAX_KEYTERMS = 1000;
const MAX_KEYTERM_WORDS = 6;
const MAX_MATTER_CODE = 64;
const MEDICAL_LANGUAGES: readonly string[] = ["en", "es", "fr", "de"];
const SNIFF_BYTES = 64;

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

function checkOptions(options: TranscribeOptions): void {
  if (options.medical === true && !MEDICAL_LANGUAGES.includes(options.language ?? "")) {
    throw invalidOption("medical needs language to be one of en, es, fr or de.");
  }
  const keyterms = options.keyterms ?? [];
  if (keyterms.length > MAX_KEYTERMS) {
    throw invalidOption(`keyterms takes at most ${String(MAX_KEYTERMS)} terms.`);
  }
  if (keyterms.some((term) => term.trim().split(/\s+/u).length > MAX_KEYTERM_WORDS)) {
    throw invalidOption(`Each keyterm is at most ${String(MAX_KEYTERM_WORDS)} words.`);
  }
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
      message: "The input could not be read.",
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
  if (source.size < 1 || source.size > MAX_FILE_BYTES) {
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
