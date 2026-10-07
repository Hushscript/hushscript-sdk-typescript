// eslint-disable-next-line n/no-unsupported-features/node-builtins -- present, if flagged experimental, in every Node 22 release (since 19.8); the rule's table lags
import { openAsBlob } from "node:fs";
import { parseBlob, parseBuffer, type IAudioMetadata } from "music-metadata";
import { AbortError, UnsupportedMediaError } from "../errors.ts";
import type { ProbeInput, Source } from "./source.ts";

const ID3_HEADER_BYTES = 10;
const MAX_ID3_TAGS = 4;
const FRAME_SCAN_BYTES = 4096;
const OPUS_SAMPLE_RATE = 48_000;
const OPUS_HEAD_BYTES = 512;
const OPUS_PRE_SKIP_AT = 10;

/**
 * music-metadata subtracts the Opus pre-skip (the samples a decoder drops at the start) from the
 * length; the probe adds it back so it never undershoots. It is read from the stream's own
 * OpusHead (u16 little-endian at offset 10), so a file with a larger pre-skip counts too.
 */
async function opusPreSkipSeconds(
  source: Source,
  signal: AbortSignal | undefined,
): Promise<number> {
  const head = await source.head(OPUS_HEAD_BYTES, signal);
  const at = ascii(head, 0, head.length).indexOf("OpusHead");
  if (at === -1 || at + OPUS_PRE_SKIP_AT + 2 > head.length) return 0;
  const preSkip =
    (head[at + OPUS_PRE_SKIP_AT] ?? 0) | ((head[at + OPUS_PRE_SKIP_AT + 1] ?? 0) << 8);
  return preSkip / OPUS_SAMPLE_RATE;
}

/**
 * Parses the real input, never a hand-built stand-in: a path becomes a lazily read Blob, and every
 * input is handed over without a MIME type, so the file extension or a Blob's own type cannot
 * pick the parser (a WebM named .mp3 must not parse as MP3).
 */
async function parse(input: ProbeInput, duration: boolean): Promise<IAudioMetadata> {
  const options = { duration, skipCovers: true };
  switch (input.kind) {
    case "path":
      return parseBlob(await openAsBlob(input.path), options);
    case "blob":
      return parseBlob(input.blob, options);
    case "bytes":
      return parseBuffer(input.bytes, undefined, options);
  }
}

function syncsafe(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) & 0x7f) * 2 ** 21 +
    ((bytes[at + 1] ?? 0) & 0x7f) * 2 ** 14 +
    ((bytes[at + 2] ?? 0) & 0x7f) * 2 ** 7 +
    ((bytes[at + 3] ?? 0) & 0x7f)
  );
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** Where the first MPEG audio frame starts, skipping ID3v2 tags; null if none shows up near the start. */
async function firstFrame(
  source: Source,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
  let at = 0;
  for (let tags = 0; tags < MAX_ID3_TAGS; tags += 1) {
    const header = await source.read(at, ID3_HEADER_BYTES, signal);
    if (ascii(header, 0, 3) !== "ID3" || header.length < ID3_HEADER_BYTES) break;
    const footer = ((header[5] ?? 0) & 0x10) === 0 ? 0 : 10;
    at += ID3_HEADER_BYTES + syncsafe(header, 6) + footer;
  }
  const window = await source.read(at, FRAME_SCAN_BYTES, signal);
  for (let i = 0; i + 4 <= window.length; i += 1) {
    const b1 = window[i + 1] ?? 0;
    if (window[i] === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0 && (b1 & 0x18) !== 0x08) {
      return window.subarray(i);
    }
  }
  return null;
}

/** Whether the first frame carries a Xing, Info or VBRI header: the duration is then in the header. */
async function hasDurationHeader(
  source: Source,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const frame = await firstFrame(source, signal);
  if (frame === null) return false;
  const b1 = frame[1] ?? 0;
  const mpeg1 = (b1 & 0x18) === 0x18;
  const mono = (frame[3] ?? 0) >> 6 === 3;
  const crc = (b1 & 0x01) === 0 ? 2 : 0;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const tag = ascii(frame, 4 + crc + sideInfo, 4);
  return tag === "Xing" || tag === "Info" || ascii(frame, 4 + 32, 4) === "VBRI";
}

function unreadable(cause?: unknown): UnsupportedMediaError {
  return new UnsupportedMediaError({
    code: "duration_unreadable",
    message: "Could not read the duration; pass durationSeconds.",
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The file's duration in seconds (float). Header reads are enough for most formats; the frames are
 * counted for an MP3 with no Xing, VBRI or Info header (spec 8.2), and the last page is read for
 * Ogg, whose headers carry no length.
 */
export async function probeDuration(source: Source, signal?: AbortSignal): Promise<number> {
  const input = source.probeInput;
  if (input === null) throw unreadable();
  let duration: number | undefined;
  try {
    let meta = await parse(input, false);
    if (
      meta.format.duration === undefined ||
      (meta.format.container === "MPEG" && !(await hasDurationHeader(source, signal)))
    ) {
      meta = await parse(input, true);
    }
    duration = meta.format.duration;
    if (duration !== undefined && /opus/i.test(meta.format.codec ?? "")) {
      duration += await opusPreSkipSeconds(source, signal);
    }
  } catch (error) {
    // A cancelled read is the caller's doing, not a file the parser could not read.
    if (error instanceof AbortError) throw error;
    throw unreadable(error);
  }
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) throw unreadable();
  return duration;
}
