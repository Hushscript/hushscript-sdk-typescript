// The golden files of the conformance suite (fixtures/exports) and how each one is rendered. Shared by
// the runner's `format` op and by test/format.test.ts, so the two cannot drift apart.
import type { components } from "../src/generated/schema";
import { Transcript } from "../src/transcript.ts";

export const GOLDEN_COUNT = 72;

const TRANSCRIPTS = [
  "escapes",
  "long-utterances",
  "multi-renamed",
  "no-labels",
  "one-speaker",
  "over-hour",
  "translated",
] as const;

// Only this transcript has translation and cleaned goldens, named `<name>.<variant>.<language>.<ext>`.
const LANGUAGE_GOLDENS = { transcript: "translated", languages: ["es", "cleaned"] } as const;

type Render = (transcript: Transcript, language: string | undefined) => string;

const VARIANTS: Record<string, { ext: string; render: Render }> = {
  "srt-captions": { ext: "srt", render: (t, language) => t.toSRT({ language }) },
  "srt-plain": { ext: "srt", render: (t, language) => t.toSRT({ language, captions: false }) },
  "vtt-captions": { ext: "vtt", render: (t, language) => t.toVTT({ language }) },
  "vtt-plain": { ext: "vtt", render: (t, language) => t.toVTT({ language, captions: false }) },
  "txt-default": { ext: "txt", render: (t, language) => t.toText({ language }) },
  "txt-nospeakers": {
    ext: "txt",
    render: (t, language) => t.toText({ language, speakers: false }),
  },
  "txt-timestamps": {
    ext: "txt",
    render: (t, language) => t.toText({ language, timestamps: true }),
  },
  "txt-nomerge": { ext: "txt", render: (t, language) => t.toText({ language, merge: false }) },
};

export interface Golden {
  /** The file name under fixtures/exports. */
  file: string;
  /** The fixture under fixtures/transcripts, without `.json`. */
  transcript: string;
  language: string | undefined;
  render: Render;
}

/** Every golden the suite ships, listed from the naming scheme (the mock serves files, not directories). */
export function goldens(): Golden[] {
  const out: Golden[] = [];
  for (const transcript of TRANSCRIPTS) {
    const languages: (string | undefined)[] =
      transcript === LANGUAGE_GOLDENS.transcript
        ? [undefined, ...LANGUAGE_GOLDENS.languages]
        : [undefined];
    for (const [variant, { ext, render }] of Object.entries(VARIANTS)) {
      for (const language of languages) {
        const middle = language === undefined ? "" : `.${language}`;
        out.push({
          file: `${transcript}.${variant}${middle}.${ext}`,
          transcript,
          language,
          render,
        });
      }
    }
  }
  return out;
}

export function renderGolden(
  golden: Golden,
  body: components["schemas"]["TranscriptDetail"],
): string {
  return golden.render(Transcript.fromApi(body), golden.language);
}
