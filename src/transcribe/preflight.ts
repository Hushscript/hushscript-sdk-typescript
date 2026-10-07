import type { Client } from "openapi-fetch";
import {
  DailyLimitError,
  FileLimitError,
  InsufficientBalanceError,
  PreflightError,
  UnsupportedMediaError,
  hintValuesFrom,
} from "../errors.ts";
import type { paths } from "../generated/schema";
import { present } from "./common.ts";
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

/** A supplied duration that is not a finite positive number is an invalid option, not an out-of-range file. */
export function checkDurationOption(seconds: number | undefined): void {
  if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
    throw invalidOption("durationSeconds must be a finite number of seconds, above 0.");
  }
}

/** Uploads accept 16 to 128 printable ASCII characters. */
function checkIdempotencyKey(key: string): void {
  let printable = key.length >= 16 && key.length <= 128;
  for (let i = 0; printable && i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    printable = code >= 0x20 && code <= 0x7e;
  }
  if (!printable) {
    throw invalidOption("idempotencyKey must be 16 to 128 printable ASCII characters.");
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

/** Duration times the multipliers a hold would carry; multichannel counts once, the channel count being unknown. */
function billableEstimate(seconds: number, options: TranscribeOptions): number {
  const medical = options.medical === true ? 1 : 0;
  const translations = 0.25 * (options.translateTo?.length ?? 0);
  return Math.ceil(seconds * (1 + medical + translations));
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
  if (sniff(await source.head(SNIFF_BYTES, signal)) === null) {
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

  const { data: account } = await api.GET("/v1/account", { signal });
  const data = present(account, "GET /v1/account");
  const needed = billableEstimate(declared, options);
  if (data.balance_seconds < needed) {
    throw new InsufficientBalanceError({
      code: "insufficient_balance",
      message: `The balance is ${String(data.balance_seconds)} s; this file needs about ${String(needed)} s.`,
      details: { neededSeconds: needed, balanceSeconds: data.balance_seconds },
      hintValues: hintValuesFrom({ neededSeconds: needed, balanceSeconds: data.balance_seconds }),
    });
  }
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
