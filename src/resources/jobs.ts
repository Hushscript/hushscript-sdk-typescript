import type { Client } from "openapi-fetch";
import type { paths } from "../generated/schema";
import { camelize } from "../camel.ts";
import { paginate } from "../paginate.ts";
import { present } from "../transcribe/common.ts";
import type { JobWaitOptions } from "../transcribe/index.ts";
import type { RawJob } from "../transcribe/wait.ts";

export type JobState = "uploading" | "fetching" | "queued" | "processing" | "done" | "failed";

/** What the job was submitted with, from the API's content-free options summary (camelCased). */
export interface JobOptions {
  /** The forced language, or null for auto-detection. */
  languageCode: string | null;
  speakerDetection: boolean;
  medicalMode: boolean;
  multichannel: boolean;
  translationTargets: string[];
  /** Whether keyterms were set; the terms themselves are not returned. */
  keyterms: boolean;
  /** Whether a context prompt was set; the prompt itself is not returned. */
  prompt: boolean;
  /** The upload's insights override, or null when it used the account default. */
  autoGenerateInsights: boolean | null;
}

/** A job as spec 6.4 defines it. Private-result and from-url fetch fields are left out; `hs.api` still returns them. */
export interface Job {
  id: string;
  /** A state the SDK does not know yet passes through as the API's own string. */
  state: JobState | (string & Record<never, never>);
  transcriptId: string | null;
  /** A short failure reason when the job failed; opaque. */
  error: string | null;
  failureKind: "media_unreadable" | "media_undecodable" | null;
  mode: string;
  declaredSeconds: number | null;
  verifiedSeconds: number | null;
  actualSeconds: number | null;
  billableSeconds: number | null;
  retryOf: string | null;
  createdAt: Date;
  options: JobOptions;
}

function toJob(raw: RawJob): Job {
  return {
    id: raw.id,
    state: raw.state,
    transcriptId: raw.transcript_id,
    error: raw.error,
    failureKind: raw.failure_kind,
    mode: raw.mode,
    declaredSeconds: raw.declared_seconds,
    verifiedSeconds: raw.verified_seconds,
    actualSeconds: raw.actual_seconds,
    billableSeconds: raw.billable_seconds,
    retryOf: raw.retry_of,
    createdAt: new Date(raw.created_at * 1000),
    options: camelize(raw.options) as JobOptions,
  };
}

export class JobsResource {
  readonly #api: Client<paths>;
  readonly #wait: (id: string, options?: JobWaitOptions) => Promise<RawJob>;

  constructor(api: Client<paths>, wait: (id: string, options?: JobWaitOptions) => Promise<RawJob>) {
    this.#api = api;
    this.#wait = wait;
  }

  /** Every job, newest first; `active` keeps only the ones that have not finished. `signal` stops the walk between and during pages. */
  list(
    options: { active?: boolean | undefined; signal?: AbortSignal | undefined } = {},
  ): AsyncIterable<Job> {
    const { signal } = options;
    return paginate(async (cursor) => {
      const query: { active?: "true"; cursor?: string } = {};
      if (options.active === true) query.active = "true";
      if (cursor !== null) query.cursor = cursor;
      const { data } = await this.#api.GET("/v1/jobs", {
        params: { query },
        ...(signal === undefined ? {} : { signal }),
      });
      const page = present(data, "GET /v1/jobs");
      return { items: page.jobs.map(toJob), nextCursor: page.next_cursor };
    }, signal);
  }

  async get(id: string): Promise<Job> {
    const { data } = await this.#api.GET("/v1/jobs/{id}", { params: { path: { id } } });
    return toJob(present(data, "GET /v1/jobs/{id}"));
  }

  /** Polls until the job is done or failed; times out with a `WaitTimeoutError` that has no resume token. */
  async wait(id: string, options?: JobWaitOptions): Promise<Job> {
    return toJob(await this.#wait(id, options));
  }
}
