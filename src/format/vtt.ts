import type { Utterance } from "../transcript.ts";
import { cueText, cuesFor, withSpeaker, type CueFormatOptions } from "./srt.ts";
import { srtTimestamp } from "./time.ts";

// WebVTT cue text reads `&` and `<` as markup and ends the cue at `-->`.
function vttCueText(text: string): string {
  return cueText(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("-->", "--&gt;");
}

export function renderVtt(utterances: readonly Utterance[], options: CueFormatOptions): string {
  const body = cuesFor(utterances, options)
    .map(
      (cue, index) =>
        `${String(index + 1)}\n${srtTimestamp(cue.startMs, ".")} --> ${srtTimestamp(cue.endMs, ".")}\n${vttCueText(withSpeaker(cue))}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
