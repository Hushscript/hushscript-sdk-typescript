import type { Utterance } from "../transcript.ts";
import { segmentCaptions, utteranceCues, type Cue } from "./captions.ts";
import { srtTimestamp } from "./time.ts";

export interface CueFormatOptions {
  /** Re-segment into readable cues (default true); false gives one cue per utterance. */
  captions?: boolean | undefined;
}

/** SRT and VTT end a cue at its first blank line, so a cue's text keeps its line breaks but loses blank ones. */
export function cueText(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** Cues for `utterances`, re-segmented unless `captions` is false. */
export function cuesFor(utterances: readonly Utterance[], options: CueFormatOptions): Cue[] {
  return options.captions === false ? utteranceCues(utterances) : segmentCaptions(utterances);
}

/** `{name}: ` goes before the text only when the display name is non-empty. */
export function withSpeaker(cue: Cue): string {
  return cue.speakerName === "" ? cue.text : `${cue.speakerName}: ${cue.text}`;
}

// An SRT reader takes a line holding `-->` for a timing line, so a run of dashes before `>` is cut
// to `->` (a plain `-->` swap would turn `--->` back into `-->`).
function arrowSafeCueText(text: string): string {
  return cueText(text).replace(/-{2,}>/g, "->");
}

export function renderSrt(utterances: readonly Utterance[], options: CueFormatOptions): string {
  return cuesFor(utterances, options)
    .map(
      (cue, index) =>
        `${String(index + 1)}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${arrowSafeCueText(withSpeaker(cue))}`,
    )
    .join("\n\n");
}
