import type { ResumeToken } from "./resume.ts";

export type Progress =
  | { stage: "uploading"; percent: number; bytesSent: number; bytesTotal: number }
  | { stage: "processing"; state: "queued" | "processing" };

export interface TranscribeOptions {
  /** At most 300 bytes; the server truncates. */
  title?: string | undefined;
  /** Forces language_code; default auto-detect. */
  language?: string | undefined;
  /** speaker_detection; default true. */
  speakers?: boolean | undefined;
  /** translation_targets; +25% each, forces speakers. */
  translateTo?: string[] | undefined;
  /**
   * keyterms_prompt. Terms are trimmed and blanks dropped; an empty list is not sent. At most 1000
   * unique terms, each at most 6 words and 128 characters (Unicode code points). With a prompt,
   * the two are compiled into one provider prompt and count together toward the prompt limit.
   */
  keyterms?: string[] | undefined;
  /**
   * Free-text context, trimmed; a blank prompt is not sent. At most 2000 characters (Unicode code
   * points). With key terms the limit applies to the compiled prompt:
   * 203 + prompt + the sum of (term + 2) for each unique term + (terms - 1).
   */
  prompt?: string | undefined;
  /** medical_mode; needs a language from the medical list (en, en_au, en_uk, en_us, es, fr, de, de_ch); 2x. Not with `vet`. */
  medical?: boolean | undefined;
  /** vet_mode (beta); needs a language the API lists for it, none yet; 2x. Not with `medical`. */
  vet?: boolean | undefined;
  /** keep_disfluencies; keeps filler words and, in many languages, repetitions and false starts. Free. */
  keepDisfluencies?: boolean | undefined;
  /** Billed per channel, up to 8. */
  multichannel?: boolean | undefined;
  /** auto_generate_insights override. */
  autoInsights?: boolean | undefined;
  /** At most 64 characters (org accounts). */
  matterCode?: string | undefined;
  /** Overrides the probe. */
  durationSeconds?: number | undefined;
  /** Bytes; required with a stream input. */
  size?: number | undefined;
  /** Default: minted once per call. */
  idempotencyKey?: string | undefined;
  /** Parallel part uploads; default 4, at most 8. */
  concurrency?: number | undefined;
  /** Seconds to wait for processing; default 3600. */
  waitTimeout?: number | undefined;
  onProgress?: ((progress: Progress) => void) | undefined;
  /** Called once the job exists. */
  onResumeToken?: ((token: ResumeToken) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface ResumeOptions {
  onProgress?: ((progress: Progress) => void) | undefined;
  signal?: AbortSignal | undefined;
  waitTimeout?: number | undefined;
  concurrency?: number | undefined;
}
