import { parseBlob, type IAudioMetadata } from "music-metadata";
import { UnsupportedMediaError } from "../errors.ts";
import type { Source } from "./source.ts";

const ID3_HEADER_BYTES = 10;
const MAX_ID3_TAGS = 4;
const FRAME_SCAN_BYTES = 4096;
// music-metadata subtracts the Opus pre-skip from the length; adding the usual 312 samples back keeps the probe from undershooting.
const OPUS_PRE_SKIP_SECONDS = 312 / 48_000;

/**
 * The source as a Blob-shaped object for music-metadata. Handing it a path would let the file
 * extension pick the parser (a WebM named .mp3 parses as MP3); a typeless Blob is read by content.
 */
function asBlob(source: Source): Blob {
  const slice = (start = 0, end = source.size): { arrayBuffer: () => Promise<ArrayBuffer> } => ({
    arrayBuffer: async () => {
      const bytes = await source.read(start, Math.max(0, end - start));
      return bytes.slice().buffer;
    },
  });
  return { size: source.size, type: "", slice } as unknown as Blob;
}

async function parse(source: Source, duration: boolean): Promise<IAudioMetadata> {
  return parseBlob(asBlob(source), { duration, skipCovers: true });
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
async function firstFrame(source: Source): Promise<Uint8Array | null> {
  let at = 0;
  for (let tags = 0; tags < MAX_ID3_TAGS; tags += 1) {
    const header = await source.read(at, ID3_HEADER_BYTES);
    if (ascii(header, 0, 3) !== "ID3" || header.length < ID3_HEADER_BYTES) break;
    const footer = ((header[5] ?? 0) & 0x10) === 0 ? 0 : 10;
    at += ID3_HEADER_BYTES + syncsafe(header, 6) + footer;
  }
  const window = await source.read(at, FRAME_SCAN_BYTES);
  for (let i = 0; i + 4 <= window.length; i += 1) {
    const b1 = window[i + 1] ?? 0;
    if (window[i] === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0 && (b1 & 0x18) !== 0x08) {
      return window.subarray(i);
    }
  }
  return null;
}

/** Whether the first frame carries a Xing, Info or VBRI header: the duration is then in the header. */
async function hasDurationHeader(source: Source): Promise<boolean> {
  const frame = await firstFrame(source);
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
export async function probeDuration(source: Source): Promise<number> {
  if (source.sequential) throw unreadable();
  let duration: number | undefined;
  try {
    let meta = await parse(source, false);
    if (
      meta.format.duration === undefined ||
      (meta.format.container === "MPEG" && !(await hasDurationHeader(source)))
    ) {
      meta = await parse(source, true);
    }
    duration = meta.format.duration;
    if (duration !== undefined && /opus/i.test(meta.format.codec ?? "")) {
      duration += OPUS_PRE_SKIP_SECONDS;
    }
  } catch (error) {
    throw unreadable(error);
  }
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) throw unreadable();
  return duration;
}
