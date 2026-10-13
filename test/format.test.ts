import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TRANSCRIPTS, goldens, renderGolden } from "../conformance/goldens";
import { MAX_CHARS_PER_LINE, MAX_CUE_MS, segmentCaptions } from "../src/format/captions";
import type { components } from "../src/generated/schema";
import { Transcript, type Utterance } from "../src/transcript";
import { BASE } from "./helpers";

type Body = components["schemas"]["TranscriptDetail"];

// The goldens are the conformance repo's fixtures/exports: read from $CONFORMANCE_DIR when set, else
// from the mock this container shares a network with.
const rawFetch = globalThis.fetch;
const dir = process.env["CONFORMANCE_DIR"];
const fromDisk = dir !== undefined && dir !== "";

/** A file of the conformance repo, by its path from the repo root. */
async function conformanceFile(path: string): Promise<string> {
  if (fromDisk) return readFile(join(dir, path), "utf8");
  const response = await rawFetch(`${BASE}/__files/${path}`);
  if (!response.ok) throw new Error(`the mock answered ${String(response.status)} for ${path}`);
  return response.text();
}

function fixture(path: string): Promise<string> {
  return conformanceFile(`fixtures/${path}`);
}

const bodies = new Map<string, Promise<Body>>();
function transcriptBody(name: string): Promise<Body> {
  let found = bodies.get(name);
  if (found === undefined) {
    found = fixture(`transcripts/${name}.json`).then((text) => JSON.parse(text) as Body);
    bodies.set(name, found);
  }
  return found;
}

describe("golden exports", () => {
  it("lists exactly the goldens and transcripts the suite ships", async () => {
    const names = goldens().map((g) => g.file);
    expect(new Set(names).size).toBe(names.length);
    // The mock cannot list a directory, so its own `format-goldens` scenario is the source for the
    // count: a golden added or dropped upstream changes it and fails here until the list follows.
    const scenario = JSON.parse(await conformanceFile("scenarios/format-goldens.json")) as {
      expect: { result: { checked: number } };
    };
    expect(names).toHaveLength(scenario.expect.result.checked);
    if (fromDisk) {
      expect([...names].sort()).toEqual((await readdir(join(dir, "fixtures", "exports"))).sort());
      expect(
        (await readdir(join(dir, "fixtures", "transcripts")))
          .map((f) => f.replace(/\.json$/, ""))
          .sort(),
      ).toEqual([...TRANSCRIPTS].sort());
    }
  });

  for (const golden of goldens()) {
    it(`golden ${golden.file}`, async () => {
      const rendered = renderGolden(golden, await transcriptBody(golden.transcript));
      expect(rendered).toBe(await fixture(`exports/${golden.file}`));
    });
  }
});

function body(utterances: Body["body"]["original"]["utterances"], extra: Partial<Body> = {}): Body {
  return {
    id: "tr_x",
    title: "T",
    language_detected: "en",
    duration_seconds: 60,
    speaker_names: {},
    tags: [],
    created_at: 1_760_000_000,
    updated_at: 1_760_000_100,
    auto_delete_at: null,
    edited: false,
    matter_code: null,
    client_code: null,
    body: { version: 1, original: { utterances }, translations: {} },
    ...extra,
  };
}

function utterance(over: Partial<Utterance> = {}): Utterance {
  return { speaker: "", speakerName: "", startMs: 0, endMs: 1000, text: "hi", ...over };
}

describe("Transcript model", () => {
  it("maps the API body to camelCase fields and Dates", () => {
    const t = Transcript.fromApi(
      body([{ speaker: "A", start_ms: 0, end_ms: 1500, text: "Hello" }], {
        speaker_names: { A: "  Dana " },
        auto_delete_at: 1_760_003_600,
        tags: ["x"],
        edited: true,
      }),
    );
    expect(t).toMatchObject({
      id: "tr_x",
      title: "T",
      language: "en",
      durationSeconds: 60,
      tags: ["x"],
      edited: true,
      speakers: { A: "  Dana " },
    });
    expect(t.createdAt).toEqual(new Date(1_760_000_000_000));
    expect(t.updatedAt).toEqual(new Date(1_760_000_100_000));
    expect(t.autoDeleteAt).toEqual(new Date(1_760_003_600_000));
    expect(t.utterances).toEqual([
      { speaker: "A", speakerName: "Dana", startMs: 0, endMs: 1500, text: "Hello" },
    ]);
    expect(t.cleaned).toBeNull();
    expect(t.languages).toEqual([]);
    expect(t.text).toBe("Dana: Hello");
  });

  it("names a speaker by the saved name, else 'Speaker {label}', else nothing for an empty label", () => {
    const t = Transcript.fromApi(
      body(
        [
          { speaker: "A", start_ms: 0, end_ms: 1, text: "a" },
          { speaker: "B", start_ms: 1, end_ms: 2, text: "b" },
          { speaker: "C", start_ms: 2, end_ms: 3, text: "c" },
          { speaker: "", start_ms: 3, end_ms: 4, text: "d" },
          { speaker: "constructor", start_ms: 4, end_ms: 5, text: "e" },
        ],
        { speaker_names: { A: "Dana", B: "   " } },
      ),
    );
    expect(t.utterances.map((u) => u.speakerName)).toEqual([
      "Dana",
      "Speaker B",
      "Speaker C",
      "",
      "Speaker constructor",
    ]);
  });

  it("separates translations from the reserved cleaned body and falls back to the original", () => {
    const original = [{ speaker: "A", start_ms: 0, end_ms: 1000, text: "Hello" }];
    const t = Transcript.fromApi({
      ...body(original),
      body: {
        version: 1,
        original: { utterances: original },
        translations: {
          es: { utterances: [{ speaker: "A", start_ms: 0, end_ms: 1000, text: "Hola" }] },
          cleaned: { utterances: [{ speaker: "A", start_ms: 0, end_ms: 1000, text: "Hello." }] },
        },
      },
    });
    expect(t.languages).toEqual(["es"]);
    expect(t.cleaned?.[0]?.text).toBe("Hello.");
    expect(t.utterancesFor("es")[0]?.text).toBe("Hola");
    expect(t.utterancesFor("cleaned")).toBe(t.cleaned);
    expect(t.utterancesFor("fr")).toBe(t.utterances);
    expect(t.utterancesFor("original")).toBe(t.utterances);
    expect(t.utterancesFor()).toBe(t.utterances);
    expect(t.utterancesFor("toString")).toBe(t.utterances);
    expect(t.toText({ language: "es" })).toBe("Speaker A: Hola");
  });

  it("returns the raw API body from toJSON, unknown fields included", () => {
    const raw = { ...body([]), x_unknown_field: { nested: true } };
    const t = Transcript.fromApi(raw);
    expect(t.toJSON()).toBe(raw);
    expect(JSON.parse(JSON.stringify(t))).toMatchObject({ x_unknown_field: { nested: true } });
  });

  it("keeps unknown utterance fields, camelCased, in the original and every translation", () => {
    const extra = { confidence: 0.9, word_count: 2, lang_hint: "en" };
    const t = Transcript.fromApi(
      body([{ speaker: "A", start_ms: 0, end_ms: 1500, text: "Hello", ...extra }], {
        speaker_names: { A: "Dana" },
        body: {
          version: 1,
          original: {
            utterances: [{ speaker: "A", start_ms: 0, end_ms: 1500, text: "Hello", ...extra }],
          },
          translations: {
            es: {
              utterances: [{ speaker: "A", start_ms: 0, end_ms: 1500, text: "Hola", ...extra }],
            },
          },
        },
      }),
    );
    expect(t.utterances).toEqual([
      {
        speaker: "A",
        speakerName: "Dana",
        startMs: 0,
        endMs: 1500,
        text: "Hello",
        confidence: 0.9,
        wordCount: 2,
        langHint: "en",
      },
    ]);
    expect(t.utterancesFor("es")).toEqual([
      {
        speaker: "A",
        speakerName: "Dana",
        startMs: 0,
        endMs: 1500,
        text: "Hola",
        confidence: 0.9,
        wordCount: 2,
        langHint: "en",
      },
    ]);
  });

  it("lets the known utterance fields win over an unknown field that camelCases to the same key", () => {
    const t = Transcript.fromApi(
      body([
        {
          speaker: "A",
          start_ms: 5,
          end_ms: 9,
          text: "Hi",
          speaker_name: "Mallory",
        } as Body["body"]["original"]["utterances"][number],
      ]),
    );
    expect(t.utterances).toEqual([
      { speaker: "A", speakerName: "Speaker A", startMs: 5, endMs: 9, text: "Hi" },
    ]);
  });

  it("renders an empty transcript as empty text and bare headers", () => {
    const t = Transcript.fromApi(body([]));
    expect(t.toText()).toBe("");
    expect(t.toSRT()).toBe("");
    expect(t.toVTT()).toBe("WEBVTT\n\n\n");
  });

  it("escapes VTT markup, cuts SRT arrows and drops blank lines from a cue", () => {
    const t = Transcript.fromApi(
      body([{ speaker: "", start_ms: 0, end_ms: 1000, text: "a & b <i> --> c --->\n \n\nd" }]),
    );
    expect(t.toVTT({ captions: false })).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\na &amp; b &lt;i> --&gt; c ---&gt;\nd\n",
    );
    expect(t.toSRT({ captions: false })).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\na & b <i> -> c ->\nd",
    );
  });

  it("keeps carriage returns and whitespace-only lines in text output", () => {
    const t = Transcript.fromApi(
      body([{ speaker: "", start_ms: 0, end_ms: 1, text: "a\r\n \nb" }]),
    );
    expect(t.toText()).toBe("a\r\n \nb");
  });

  it("formats hours in timestamps and SRT cue times", () => {
    const t = Transcript.fromApi(
      body([{ speaker: "", start_ms: 3_725_999, end_ms: 3_726_000, text: "late" }]),
    );
    expect(t.toText({ timestamps: true })).toBe("[1:02:05] late");
    expect(t.toSRT({ captions: false })).toBe("1\n01:02:05,999 --> 01:02:06,000\nlate");
  });
});

describe("caption segmentation", () => {
  const words = fc
    .array(
      fc.constantFrom(
        "a",
        "b",
        "c",
        "X",
        "Y",
        "Z",
        "0",
        "1",
        "8",
        "9",
        ".",
        ",",
        "!",
        "?",
        "'",
        "-",
      ),
      { minLength: 1, maxLength: 60 },
    )
    .map((letters) => letters.join(""));
  // Ordered, non-overlapping utterances: a transcript's own shape.
  const utterances = fc
    .array(
      fc.record({
        gap: fc.nat(2000),
        span: fc.nat(30_000),
        text: fc.array(words, { maxLength: 40 }).map((w) => w.join(" ")),
      }),
      { maxLength: 12 },
    )
    .map((rows) => {
      let at = 0;
      return rows.map((row): Utterance => {
        const startMs = at + row.gap;
        at = startMs + row.span;
        return utterance({ startMs, endMs: at, text: row.text });
      });
    });

  it("never ends a cue before it starts, keeps cues in order and caps each at 7 s", () => {
    fc.assert(
      fc.property(utterances, (input) => {
        const cues = segmentCaptions(input);
        let previousStart = 0;
        for (const cue of cues) {
          expect(cue.endMs).toBeGreaterThanOrEqual(cue.startMs);
          expect(cue.startMs).toBeGreaterThanOrEqual(previousStart);
          expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(MAX_CUE_MS);
          previousStart = cue.startMs;
        }
      }),
    );
  });

  it("wraps to lines of at most 42 characters unless a line is one overlong word, two lines to a cue", () => {
    fc.assert(
      fc.property(utterances, (input) => {
        for (const cue of segmentCaptions(input)) {
          const lines = cue.text === "" ? [] : cue.text.split("\n");
          expect(lines.length).toBeLessThanOrEqual(2);
          for (const line of lines) {
            if (line.length > MAX_CHARS_PER_LINE) expect(line).not.toContain(" ");
          }
        }
      }),
    );
  });

  it("keeps every word of an utterance and ends its last cue at its end, or 7 s after its start", () => {
    fc.assert(
      fc.property(utterances, (input) => {
        for (const u of input) {
          const cues = segmentCaptions([u]);
          const last = cues.at(-1);
          // The 7 s cap still applies to a last cue that would run longer.
          expect(last?.endMs).toBe(Math.min(u.endMs, (last?.startMs ?? 0) + MAX_CUE_MS));
          const kept = cues.flatMap((c) => c.text.split(/\s+/).filter(Boolean));
          expect(kept).toEqual(u.text.split(/\s+/).filter(Boolean));
        }
      }),
    );
  });

  it("counts line length in UTF-16 units: 21 astral emoji fill a line, so the next word wraps", () => {
    const emoji = "\u{1F600}".repeat(21);
    expect(emoji).toHaveLength(42);
    const cues = segmentCaptions([utterance({ text: `${emoji} ok` })]);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe(`${emoji}\nok`);
  });

  it("does not count the speaker prefix toward the 42 characters", () => {
    const long = "word ".repeat(8).trim();
    const t = Transcript.fromApi(
      body([{ speaker: "A", start_ms: 0, end_ms: 4000, text: long }], {
        speaker_names: { A: "A Very Long Display Name Indeed" },
      }),
    );
    expect(t.toSRT()).toBe(
      "1\n00:00:00,000 --> 00:00:04,000\nA Very Long Display Name Indeed: word word word word word word word word",
    );
    expect(t.toSRT({ captions: false })).toBe(t.toSRT());
  });
});
