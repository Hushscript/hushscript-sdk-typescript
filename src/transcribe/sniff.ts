export type MediaKind = "mp3" | "isobmff" | "wav" | "flac" | "ogg";

function startsWith(head: Uint8Array, text: string, offset = 0): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

// MPEG-1/2/2.5 Layer III frame sync, as the backend's audio probe reads it.
function isLayer3Sync(head: Uint8Array): boolean {
  const [a, b] = head;
  return a === 0xff && b !== undefined && (b & 0xe0) === 0xe0 && (b & 0x06) === 0x02;
}

/**
 * The container by magic bytes (spec 8.1), never by file name. Looks only at the first bytes and
 * never throws; `null` means the file is not one of the accepted formats.
 */
export function sniff(head: Uint8Array): MediaKind | null {
  if (startsWith(head, "ID3")) return "mp3";
  if (head.length >= 12 && startsWith(head, "ftyp", 4)) return "isobmff";
  if (
    head.length >= 12 &&
    (startsWith(head, "RIFF") || startsWith(head, "RF64") || startsWith(head, "BW64")) &&
    startsWith(head, "WAVE", 8)
  ) {
    return "wav";
  }
  if (startsWith(head, "fLaC")) return "flac";
  if (startsWith(head, "OggS")) return "ogg";
  return isLayer3Sync(head) ? "mp3" : null;
}
