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
  /** keyterms_prompt; at most 1000 terms of at most 6 words. */
  keyterms?: string[] | undefined;
  /** Free-text context. */
  prompt?: string | undefined;
  /** medical_mode; language must be en, es, fr or de; 2x. */
  medical?: boolean | undefined;
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
