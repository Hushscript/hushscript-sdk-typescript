import { renderSrt } from "./format/srt.ts";
import { renderText, type TextFormatOptions } from "./format/txt.ts";
import { renderVtt } from "./format/vtt.ts";
import type { components } from "./generated/schema";

type TranscriptBody = components["schemas"]["TranscriptDetail"];

/** The reserved translation key that holds the AI-cleaned body. */
const CLEANED_KEY = "cleaned";

export interface Utterance {
  /** The provider's raw label; empty for a transcript without speaker labels. */
  speaker: string;
  /** The saved name, else "Speaker {label}", else "" for an empty label. */
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface LanguageOptions {
  /** A translation locale or "cleaned"; the original when absent or unknown. */
  language?: string | undefined;
}

export interface CaptionOptions extends LanguageOptions {
  /** Readable cues of at most 2 lines of 42 characters (default true); false gives one cue per utterance. */
  captions?: boolean | undefined;
}

export interface TextOptions extends LanguageOptions, TextFormatOptions {}

function seconds(value: number): Date {
  return new Date(value * 1000);
}

// Labels are user-editable, so one like "constructor" must not resolve to an Object.prototype member.
function displayName(label: string, names: Record<string, string>): string {
  const saved = Object.hasOwn(names, label) ? names[label] : undefined;
  const named = typeof saved === "string" ? saved.trim() : "";
  if (named !== "") return named;
  return label.trim() === "" ? "" : `Speaker ${label}`;
}

function utterancesOf(
  language: components["schemas"]["TranscriptLanguage"],
  names: Record<string, string>,
): Utterance[] {
  return language.utterances.map((u) => ({
    speaker: u.speaker,
    speakerName: displayName(u.speaker, names),
    startMs: u.start_ms,
    endMs: u.end_ms,
    text: u.text,
  }));
}

/** A finished transcript with its formatters. */
export class Transcript {
  readonly id: string;
  readonly title: string;
  readonly language: string | null;
  readonly durationSeconds: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly autoDeleteAt: Date | null;
  readonly tags: string[];
  readonly edited: boolean;
  /** Label to display name, for the speakers that were renamed. */
  readonly speakers: Record<string, string>;
  /** The original language. */
  readonly utterances: Utterance[];
  /** Translation locales, without the reserved "cleaned". */
  readonly languages: string[];
  /** The AI-cleaned body, when there is one. */
  readonly cleaned: Utterance[] | null;
  readonly #raw: TranscriptBody;
  readonly #translations = new Map<string, Utterance[]>();

  private constructor(raw: TranscriptBody) {
    this.#raw = raw;
    this.id = raw.id;
    this.title = raw.title;
    this.language = raw.language_detected;
    this.durationSeconds = raw.duration_seconds;
    this.createdAt = seconds(raw.created_at);
    this.updatedAt = seconds(raw.updated_at);
    this.autoDeleteAt = raw.auto_delete_at === null ? null : seconds(raw.auto_delete_at);
    this.tags = raw.tags;
    this.edited = raw.edited;
    this.speakers = raw.speaker_names;
    this.utterances = utterancesOf(raw.body.original, raw.speaker_names);
    const translations = raw.body.translations;
    this.languages = Object.keys(translations).filter((key) => key !== CLEANED_KEY);
    this.cleaned = Object.hasOwn(translations, CLEANED_KEY) ? this.#translation(CLEANED_KEY) : null;
  }

  /** Builds a transcript from a `GET /v1/transcripts/{id}` body, which `toJSON()` returns again. */
  static fromApi(body: TranscriptBody): Transcript {
    return new Transcript(body);
  }

  #translation(language: string): Utterance[] {
    const known = this.#translations.get(language);
    if (known !== undefined) return known;
    const body = this.#raw.body.translations[language];
    const built = body === undefined ? this.utterances : utterancesOf(body, this.speakers);
    this.#translations.set(language, built);
    return built;
  }

  /** The plain text, the same as `toText()`. */
  get text(): string {
    return this.toText();
  }

  /** The translation (or "cleaned" body) for `language`; the original when there is none. */
  utterancesFor(language?: string): Utterance[] {
    if (language === undefined || language === "original") return this.utterances;
    return Object.hasOwn(this.#raw.body.translations, language)
      ? this.#translation(language)
      : this.utterances;
  }

  toSRT(options: CaptionOptions = {}): string {
    return renderSrt(this.utterancesFor(options.language), options);
  }

  toVTT(options: CaptionOptions = {}): string {
    return renderVtt(this.utterancesFor(options.language), options);
  }

  toText(options: TextOptions = {}): string {
    return renderText(this.utterancesFor(options.language), options);
  }

  /** The API body this transcript was built from, unknown fields included. */
  toJSON(): TranscriptBody {
    return this.#raw;
  }
}
