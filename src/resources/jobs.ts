import type { Client } from "openapi-fetch";
import type { paths } from "../generated/schema";
import { paginate } from "../paginate.ts";
import { present } from "../transcribe/common.ts";
import type { JobWaitOptions } from "../transcribe/index.ts";
import type { RawJob } from "../transcribe/wait.ts";

export type JobState = "uploading" | "fetching" | "queued" | "processing" | "done" | "failed";

export interface Job {
  id: string;
  /** A state the SDK does not know yet passes through as the API's own string. */
  state: JobState | (string & Record<never, never>);
  mode: string;
  declaredSeconds: number;
  verifiedSeconds: number | null;
  actualSeconds: number | null;
  billableSeconds: number;
  /** A short failure reason when the job failed; opaque. */
  error: string | null;
  failureKind: "media_unreadable" | "media_undecodable" | null;
  retryOf: string | null;
  createdAt: Date;
  transcriptId: string | null;
}

function toJob(raw: RawJob): Job {
  return {
    id: raw.id,
    state: raw.state,
    mode: raw.mode,
    declaredSeconds: raw.declared_seconds,
    verifiedSeconds: raw.verified_seconds,
    actualSeconds: raw.actual_seconds,
    billableSeconds: raw.billable_seconds,
    error: raw.error,
    failureKind: raw.failure_kind,
    retryOf: raw.retry_of,
    createdAt: new Date(raw.created_at * 1000),
    transcriptId: raw.transcript_id,
  };
}

export class JobsResource {
  readonly #api: Client<paths>;
  readonly #wait: (id: string, options?: JobWaitOptions) => Promise<RawJob>;

  constructor(api: Client<paths>, wait: (id: string, options?: JobWaitOptions) => Promise<RawJob>) {
    this.#api = api;
    this.#wait = wait;
  }

  /** Every job, newest first; `active` keeps only the ones that have not finished. */
  list(options: { active?: boolean | undefined } = {}): AsyncIterable<Job> {
    return paginate(async (cursor) => {
      const query: { active?: "true"; cursor?: string } = {};
      if (options.active === true) query.active = "true";
      if (cursor !== null) query.cursor = cursor;
      const { data } = await this.#api.GET("/v1/jobs", { params: { query } });
      const page = present(data, "GET /v1/jobs");
      return { items: page.jobs.map(toJob), nextCursor: page.next_cursor };
    });
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
