import type { Client } from "openapi-fetch";
import type { components, paths } from "../generated/schema";
import { camelize, unknownFields } from "../camel.ts";
import { nextCursorOf, paginate } from "../paginate.ts";
import { JOB_LIST } from "../shapes.ts";
import { readBody } from "../transcribe/common.ts";
import type { JobWaitOptions } from "../transcribe/index.ts";
import { checkPathId } from "../transcribe/preflight.ts";
import { readJob, type RawJob } from "../transcribe/wait.ts";

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

/**
 * A job: camelCase fields and options. Private-result and from-url fetch fields are left out; `hs.api`
 * still returns them. A field the API adds later is kept on the object at run time, camelCased.
 */
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

// Every field the schema gives a job. The private-result and from-url fetch fields are known and
// left out (see `Job`); any other field is kept on the result, camelized.
const JOB_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "id",
    "state",
    "mode",
    "declared_seconds",
    "verified_seconds",
    "actual_seconds",
    "billable_seconds",
    "error",
    "failure_kind",
    "retry_of",
    "created_at",
    "transcript_id",
    "private_result_expires_at",
    "private_result_available",
    "options",
    "fetched_bytes",
    "fetch_total_bytes",
  ] satisfies (keyof RawJob)[]),
]);

function toJob(raw: RawJob): Job {
  return {
    ...unknownFields(raw, JOB_FIELDS),
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
      const page = await readBody<components["schemas"]["JobList"]>(
        this.#api.GET("/v1/jobs", {
          params: { query },
          parseAs: "text",
          ...(signal === undefined ? {} : { signal }),
        }),
        "GET /v1/jobs",
        JOB_LIST,
      );
      return { items: page.jobs.map(toJob), nextCursor: nextCursorOf(page.next_cursor) };
    }, signal);
  }

  async get(id: string): Promise<Job> {
    return toJob(await readJob(this.#api, checkPathId(id, "id")));
  }

  /** Polls until the job is done or failed; times out with a `WaitTimeoutError` that has no resume token. */
  async wait(id: string, options?: JobWaitOptions): Promise<Job> {
    return toJob(await this.#wait(checkPathId(id, "id"), options));
  }
}
