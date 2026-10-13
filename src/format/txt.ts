import type { Utterance } from "../transcript.ts";
import { msToClock } from "./time.ts";

export interface TextFormatOptions {
  /** Prefix each block with its speaker (default true). */
  speakers?: boolean | undefined;
  /** Prefix each block with `[M:SS] ` or `[H:MM:SS] ` (default false). */
  timestamps?: boolean | undefined;
  /** Merge consecutive utterances of the same speaker label (default true). */
  merge?: boolean | undefined;
}

interface Block {
  speaker: string;
  speakerName: string;
  startMs: number;
  text: string;
}

function blocksOf(utterances: readonly Utterance[], merge: boolean): Block[] {
  const blocks: Block[] = [];
  for (const u of utterances) {
    const last = blocks.at(-1);
    if (merge && last?.speaker === u.speaker) {
      last.text += ` ${u.text}`;
    } else {
      blocks.push({
        speaker: u.speaker,
        speakerName: u.speakerName,
        startMs: u.startMs,
        text: u.text,
      });
    }
  }
  return blocks;
}

/** Plain text: `Name: text` blocks joined by a blank line. `\r` and whitespace-only lines are kept as they come. */
export function renderText(utterances: readonly Utterance[], options: TextFormatOptions): string {
  return blocksOf(utterances, options.merge !== false)
    .map((block) => {
      const who = options.speakers === false ? "" : block.speakerName;
      const prefix = options.timestamps === true ? `[${msToClock(block.startMs)}] ` : "";
      return `${prefix}${who === "" ? block.text : `${who}: ${block.text}`}`;
    })
    .join("\n\n");
}
