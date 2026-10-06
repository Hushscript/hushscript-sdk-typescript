import type { Utterance } from "../transcript.ts";

/** One subtitle cue; `speaker` is the raw label and `speakerName` its display form. */
export interface Cue {
  startMs: number;
  endMs: number;
  speaker: string;
  speakerName: string;
  text: string;
}

export const MAX_CHARS_PER_LINE = 42;
const MAX_LINES = 2;
export const MAX_CUE_MS = 7000;

/** Word-wraps `text` into cues of at most `maxLines` lines of `maxChars`; an overlong word keeps its own line. */
function wrapIntoCues(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const cues: string[] = [];
  let lines: string[] = [];
  let line = "";
  const flushLine = (): void => {
    if (line !== "") lines.push(line);
    line = "";
  };
  const flushCue = (): void => {
    flushLine();
    if (lines.length > 0) cues.push(lines.join("\n"));
    lines = [];
  };
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      flushLine();
      if (lines.length >= maxLines) flushCue();
      line = word;
    }
  }
  flushCue();
  return cues.length > 0 ? cues : [""];
}

/** One cue per utterance (`captions: false`). */
export function utteranceCues(utterances: readonly Utterance[]): Cue[] {
  return utterances.map((u) => ({
    startMs: u.startMs,
    endMs: u.endMs,
    speaker: u.speaker,
    speakerName: u.speakerName,
    text: u.text,
  }));
}

/**
 * Re-slices utterances into readable cues (spec 6.2): lines of at most 42 characters, two lines to a
 * cue, the utterance span split by character share, cues capped at 7000 ms, and the last cue of an
 * utterance ending exactly at its end.
 */
export function segmentCaptions(utterances: readonly Utterance[]): Cue[] {
  const textChars = (cue: string): number => cue.replaceAll("\n", " ").length;
  const out: Cue[] = [];
  for (const u of utterances) {
    const chunks = wrapIntoCues(u.text, MAX_CHARS_PER_LINE, MAX_LINES);
    const span = Math.max(0, u.endMs - u.startMs);
    const totalChars = chunks.reduce((sum, chunk) => sum + textChars(chunk), 0) || 1;
    let accChars = 0;
    chunks.forEach((text, index) => {
      // Positions come from the cumulative character share, not from the previous cue's capped end,
      // so the cap never shifts later cues.
      const startMs = u.startMs + Math.round((span * accChars) / totalChars);
      accChars += Math.max(1, textChars(text));
      let endMs =
        index === chunks.length - 1
          ? u.endMs
          : u.startMs + Math.round((span * accChars) / totalChars);
      if (endMs - startMs > MAX_CUE_MS) endMs = startMs + MAX_CUE_MS;
      if (endMs < startMs) endMs = startMs;
      out.push({ startMs, endMs, speaker: u.speaker, speakerName: u.speakerName, text });
    });
  }
  return out;
}
