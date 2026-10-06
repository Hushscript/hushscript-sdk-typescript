import { randomUUID } from "node:crypto";
import type { Client } from "openapi-fetch";
import type { ResolvedConfig } from "../config.ts";
import { AbortError, HushscriptError, NotFoundError, UploadError } from "../errors.ts";
import type { paths } from "../generated/schema";
import { Transcript } from "../transcript.ts";
import { present } from "./common.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { checkDurationOption, invalidOption, preflight } from "./preflight.ts";
import {
  assertSameFile,
  decodeResumeToken,
  encodeResumeToken,
  fileRequired,
  jobMissing,
  type ResumeState,
  type ResumeToken,
} from "./resume.ts";
import { openSource, type FileInput, type Source } from "./source.ts";
import type { Progress, ResumeOptions, TranscribeOptions } from "./types.ts";
import { uploadParts } from "./upload.ts";
import {
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  failureOf,
  readJob,
  waitForJob,
  type RawJob,
} from "./wait.ts";

export type { ResumeToken } from "./resume.ts";
export type { Progress, ResumeOptions, TranscribeOptions } from "./types.ts";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

export interface JobWaitOptions {
  waitTimeout?: number | undefined;
  onProgress?: ((progress: Progress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

type CreateBody = NonNullable<
  paths["/v1/uploads"]["post"]["requestBody"]
>["content"]["application/json"];

function transcriptionOptions(options: TranscribeOptions): CreateBody["transcription_options"] {
  const out: NonNullable<CreateBody["transcription_options"]> = {};
  if (options.language !== undefined) out.language_code = options.language;
  if (options.speakers !== undefined) out.speaker_detection = options.speakers;
  if (options.translateTo !== undefined) out.translation_targets = options.translateTo;
  if (options.keyterms !== undefined) out.keyterms_prompt = options.keyterms;
  if (options.prompt !== undefined) out.prompt = options.prompt;
  if (options.medical !== undefined) out.medical_mode = options.medical;
  if (options.multichannel !== undefined) out.multichannel = options.multichannel;
  if (options.autoInsights !== undefined) out.auto_generate_insights = options.autoInsights;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Spec 8.6: bad options are refused before any request, never clamped. */
function checkRuntimeOptions(options: {
  concurrency?: number | undefined;
  waitTimeout?: number | undefined;
  durationSeconds?: number | undefined;
}): {
  concurrency: number;
  waitTimeout: number;
} {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw invalidOption(`concurrency must be a whole number from 1 to ${String(MAX_CONCURRENCY)}.`);
  }
  const waitTimeout = options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  if (!Number.isFinite(waitTimeout) || waitTimeout <= 0) {
    throw invalidOption("waitTimeout must be a positive number of seconds.");
  }
  checkDurationOption(options.durationSeconds);
  return { concurrency, waitTimeout };
}

/** Everything the upload and wait stages share, for one transcribe or resume call. */
interface Run {
  state: ResumeState;
  token: ResumeToken;
  source: Source | null;
  concurrency: number;
  waitTimeout: number;
  signal: AbortSignal;
  onProgress: ((progress: Progress) => void) | undefined;
}

/** The friendly transcribe pipeline (spec 8): preflight, create, parts, complete, wait, fetch. */
export class Pipeline {
  readonly #cfg: ResolvedConfig;
  readonly #api: Client<paths>;

  constructor(cfg: ResolvedConfig, api: Client<paths>) {
    this.#cfg = cfg;
    this.#api = api;
  }

  async transcribe(file: FileInput, options: TranscribeOptions = {}): Promise<Transcript> {
    const { concurrency, waitTimeout } = checkRuntimeOptions(options);
    const signal = options.signal ?? new AbortController().signal;
    let token: ResumeToken | null = null;
    // Set once the create is about to go out: from then on an error carries the key (spec 7.3).
    let sentKey: string | null = null;
    let source: Source | null = null;
    try {
      source = await openSource(file, options.size);
      if (source.sequential && options.durationSeconds === undefined) {
        throw invalidOption("A stream input needs durationSeconds and size.");
      }
      const durationSeconds = await preflight(source, options, this.#api, signal);
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      options.onProgress?.({
        stage: "uploading",
        percent: 0,
        bytesSent: 0,
        bytesTotal: source.size,
      });
      const body: CreateBody = {
        size_bytes: source.size,
        duration_seconds: durationSeconds,
        idempotency_key: idempotencyKey,
      };
      if (options.title !== undefined) body.title = options.title;
      if (options.matterCode !== undefined) body.matter_code = options.matterCode;
      const transcription = transcriptionOptions(options);
      if (transcription !== undefined) body.transcription_options = transcription;
      sentKey = idempotencyKey;
      const created = present(
        (await this.#api.POST("/v1/uploads", { body, signal })).data,
        "POST /v1/uploads",
      );
      const state: ResumeState = {
        jobId: created.job_id,
        idempotencyKey,
        size: source.size,
        durationSeconds,
      };
      token = encodeResumeToken(state);
      options.onResumeToken?.(token);
      return await this.#finish(created, {
        state,
        token,
        source,
        concurrency,
        waitTimeout,
        signal,
        onProgress: options.onProgress,
      });
    } catch (error) {
      throw this.#annotate(error, token, signal, sentKey);
    } finally {
      await source?.close();
    }
  }

  async resume(
    token: ResumeToken,
    file?: FileInput,
    options: ResumeOptions = {},
  ): Promise<Transcript> {
    const state = decodeResumeToken(token);
    const { concurrency, waitTimeout } = checkRuntimeOptions(options);
    const signal = options.signal ?? new AbortController().signal;
    let source: Source | null = null;
    try {
      if (file !== undefined) {
        source = await openSource(file, state.size);
        assertSameFile(state, source.size);
      }
      const run: Run = {
        state,
        token,
        source,
        concurrency,
        waitTimeout,
        signal,
        onProgress: options.onProgress,
      };
      // A replayed create would mint a new job, and a new hold, for a job that was deleted or pruned.
      const job = await readJob(this.#api, state.jobId, signal).catch((error: unknown) => {
        throw error instanceof NotFoundError ? jobMissing() : error;
      });
      if (job.state !== "uploading")
        return await this.#finish({ state: job.state, upload: null }, run, job);
      if (source === null) throw fileRequired();
      // Replaying the create with the original key returns the same job, with no second hold.
      const created = present(
        (
          await this.#api.POST("/v1/uploads", {
            body: {
              size_bytes: state.size,
              duration_seconds: Math.ceil(state.durationSeconds),
              idempotency_key: state.idempotencyKey,
            },
            signal,
          })
        ).data,
        "POST /v1/uploads",
      );
      if (created.job_id !== state.jobId) throw jobMissing();
      return await this.#finish(created, run);
    } catch (error) {
      throw this.#annotate(error, token, signal, null);
    } finally {
      await source?.close();
    }
  }

  async waitForJob(id: string, options: JobWaitOptions = {}): Promise<RawJob> {
    const { waitTimeout } = checkRuntimeOptions({ waitTimeout: options.waitTimeout });
    return waitForJob({
      api: this.#api,
      clock: this.#cfg.clock,
      jobId: id,
      waitTimeout,
      signal: options.signal ?? new AbortController().signal,
      onProgress: options.onProgress,
      resumeToken: null,
    });
  }

  /** Adds the resume token to a cancellation and, after a create was sent, the key to every error (spec 7.1, 7.3). */
  #annotate(
    error: unknown,
    token: ResumeToken | null,
    signal: AbortSignal,
    key: string | null,
  ): unknown {
    const cancelled = error instanceof AbortError || signal.aborted;
    const wrap =
      cancelled && token !== null && !(error instanceof AbortError && error.resumeToken !== null);
    const out = wrap
      ? new AbortError({
          message: error instanceof Error ? error.message : "The request was aborted.",
          cause: error,
          resumeToken: token,
        })
      : error;
    if (key !== null && out instanceof HushscriptError) {
      out.idempotencyKey = key;
      out.resumeToken ??= token;
    }
    return out;
  }

  /** `known` is the job as `resume()` just read it, for a job that is not uploading. */
  async #finish(
    created: Pick<CreateResponse, "state" | "upload">,
    run: Run,
    known: RawJob | null = null,
  ): Promise<Transcript> {
    const { state, signal } = run;
    let jobState = created.state;
    let finished = known;
    if (created.state === "uploading") {
      if (run.source === null) throw fileRequired();
      jobState = await this.#upload(created, run, run.source);
      finished = null;
    }
    if (jobState === "done" || jobState === "failed") {
      // The complete response has no transcript id: one job read gives it, with no poll loop.
      return await this.#fetch(finished ?? (await readJob(this.#api, state.jobId, signal)), run);
    }
    if (jobState === "queued" || jobState === "processing") {
      run.onProgress?.({ stage: "processing", state: jobState });
    }
    const job = await waitForJob({
      api: this.#api,
      clock: this.#cfg.clock,
      jobId: state.jobId,
      waitTimeout: run.waitTimeout,
      signal,
      onProgress: run.onProgress,
      resumeToken: run.token,
    });
    return await this.#fetch(job, run);
  }

  async #upload(
    created: Pick<CreateResponse, "upload">,
    run: Run,
    source: Source,
  ): Promise<string> {
    const { state } = run;
    const stop = new AbortController();
    const signal = AbortSignal.any([run.signal, stop.signal]);
    const failure: { error?: unknown; failed: boolean } = { failed: false };
    const heartbeat = runHeartbeat({
      clock: this.#cfg.clock,
      signal,
      send: () =>
        this.#api.POST("/v1/uploads/{job}/heartbeat", {
          params: { path: { job: state.jobId } },
          signal,
        }),
    }).catch((error: unknown) => {
      failure.failed = true;
      failure.error = error;
      stop.abort();
    });
    try {
      const acks = await uploadParts({
        cfg: this.#cfg,
        api: this.#api,
        jobId: state.jobId,
        source,
        plan: created.upload,
        concurrency: run.concurrency,
        signal,
        onAcked: (bytesSent) => {
          run.onProgress?.({
            stage: "uploading",
            percent: Math.floor((bytesSent * 100) / source.size),
            bytesSent,
            bytesTotal: source.size,
          });
        },
      });
      if (failure.failed) throw failure.error;
      const completed = await this.#api.POST("/v1/uploads/{job}/complete", {
        params: { path: { job: state.jobId } },
        ...(acks === null || acks.length === 0 ? {} : { body: { parts: acks } }),
        signal,
      });
      return present(completed.data, "POST /v1/uploads/{job}/complete").state;
    } catch (error) {
      // A heartbeat that stopped the upload (a 401) is the real cause of whatever abort followed.
      throw failure.failed ? failure.error : error;
    } finally {
      stop.abort();
      await heartbeat;
    }
  }

  async #fetch(job: RawJob, run: Run): Promise<Transcript> {
    if (job.state === "failed") throw failureOf(job);
    if (job.transcript_id === null) {
      throw new UploadError({
        code: "transcript_missing",
        message: "The job is done but has no transcript id.",
      });
    }
    const { data } = await this.#api.GET("/v1/transcripts/{id}", {
      params: { path: { id: job.transcript_id } },
      signal: run.signal,
    });
    return Transcript.fromApi(present(data, "GET /v1/transcripts/{id}"));
  }
}

type CreateResponse = paths["/v1/uploads"]["post"]["responses"][200]["content"]["application/json"];
