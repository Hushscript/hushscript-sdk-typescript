import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { parseBlob, type IAudioMetadata } from "music-metadata";
import { AbortError, UnsupportedMediaError, describeError } from "../errors.ts";
import { aborted } from "./common.ts";
import type { Source } from "./source.ts";

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

// The tokenizer only uses size, type, slice() and arrayBuffer(). Read through the source so
// every parser range observes cancellation, without copying the whole input into a Blob.
class ProbeBlob extends Blob {
  readonly source: Source;
  readonly signal: AbortSignal | undefined;
  readonly offset: number;
  readonly length: number;
  readonly progress: { reads: number };

  constructor(
    source: Source,
    signal: AbortSignal | undefined,
    offset = 0,
    length = source.size,
    progress = { reads: 0 },
  ) {
    super();
    this.source = source;
    this.signal = signal;
    this.offset = offset;
    this.length = length;
    this.progress = progress;
  }

  override get size(): number {
    return this.length;
  }

  override slice(start = 0, end = this.size): Blob {
    const clamp = (at: number): number =>
      Math.min(this.size, Math.max(0, at < 0 ? this.size + at : at));
    const from = clamp(start);
    return new ProbeBlob(
      this.source,
      this.signal,
      this.offset + from,
      Math.max(0, clamp(end) - from),
      this.progress,
    );
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    // Resolved memory reads must also let externally scheduled aborts reach the parser.
    if (++this.progress.reads % 64 === 0) await yieldToEventLoop();
    if (this.signal?.aborted) throw aborted(this.signal);
    const bytes = await this.source.read(this.offset, this.length, this.signal);
    if (this.signal?.aborted) throw aborted(this.signal);
    return bytes.slice().buffer;
  }
}

async function parse(
  source: Source,
  duration: boolean,
  signal: AbortSignal | undefined,
): Promise<IAudioMetadata> {
  if (signal?.aborted) throw aborted(signal);
  const metadata = await parseBlob(new ProbeBlob(source, signal), { duration, skipCovers: true });
  if (signal?.aborted) throw aborted(signal);
  return metadata;
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
    message: `Could not read the duration${cause === undefined ? "" : ` (${describeError(cause)})`}; pass durationSeconds.`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The file's duration in seconds (float). Header reads are enough for most formats; the frames are
 * counted for an MP3 with no Xing, VBRI or Info header, and the last page is read for
 * Ogg, whose headers carry no length.
 */
export async function probeDuration(source: Source, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw aborted(signal);
  if (source.probeInput === null) throw unreadable();
  let duration: number | undefined;
  try {
    let meta = await parse(source, false, signal);
    if (
      meta.format.duration === undefined ||
      (meta.format.container === "MPEG" && !(await hasDurationHeader(source, signal)))
    ) {
      meta = await parse(source, true, signal);
    }
    duration = meta.format.duration;
    if (duration !== undefined && /opus/i.test(meta.format.codec ?? "")) {
      duration += await opusPreSkipSeconds(source, signal);
    }
  } catch (error) {
    // A cancelled read is the caller's doing, not a file the parser could not read.
    if (signal?.aborted) throw aborted(signal);
    if (error instanceof AbortError) throw error;
    throw unreadable(error);
  }
  if (signal?.aborted) throw aborted(signal);
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) throw unreadable();
  return duration;
}
