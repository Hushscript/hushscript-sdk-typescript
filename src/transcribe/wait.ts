import type { Client } from "openapi-fetch";
import type { Clock } from "../clock.ts";
import { JobFailedError, WaitTimeoutError } from "../errors.ts";
import type { components, paths } from "../generated/schema";
import { JOB_ONE } from "../shapes.ts";
import { readBody, sleepOrAbort } from "./common.ts";
import type { Progress } from "./types.ts";

/** A job as the API sends it; `hs.jobs` hands out the camelCase `Job`. */
export type RawJob = components["schemas"]["Job"];

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 3600;
const POLL_START_MS = 5000;
const POLL_FACTOR = 1.5;
const POLL_CEILING_MS = 15_000;

function isFinished(job: RawJob): boolean {
  return job.state === "done" || job.state === "failed";
}

export function failureOf(job: RawJob): JobFailedError {
  const kind = job.failure_kind === "media_unreadable" || job.failure_kind === "media_undecodable";
  return new JobFailedError({
    message: job.error ?? "The job failed.",
    error: job.error,
    failureKind: kind ? job.failure_kind : null,
    jobId: job.id,
  });
}

export async function readJob(
  api: Client<paths>,
  id: string,
  signal?: AbortSignal,
): Promise<RawJob> {
  return readBody<RawJob>(
    api.GET("/v1/jobs/{id}", {
      params: { path: { id } },
      parseAs: "text",
      ...(signal === undefined ? {} : { signal }),
    }),
    "GET /v1/jobs/{id}",
    JOB_ONE,
  );
}

export interface WaitSettings {
  api: Client<paths>;
  clock: Clock;
  jobId: string;
  /** Seconds; the job keeps running when this runs out. */
  waitTimeout: number;
  signal: AbortSignal;
  onProgress?: ((progress: Progress) => void) | undefined;
  /** The token a timeout carries; `jobs.wait` has none to give. */
  resumeToken: string | null;
}

/** Polls the job at 5 s, times 1.5 up to 15 s, until done or failed; a timeout is `WaitTimeoutError`. */
export async function waitForJob(settings: WaitSettings): Promise<RawJob> {
  const { api, clock, jobId, signal } = settings;
  const startedAt = clock.now();
  const deadline = startedAt + settings.waitTimeout * 1000;
  let interval = POLL_START_MS;
  for (;;) {
    const job = await readJob(api, jobId, signal);
    if (isFinished(job)) return job;
    if (job.state === "queued" || job.state === "processing") {
      settings.onProgress?.({ stage: "processing", state: job.state });
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      throw new WaitTimeoutError({
        message: `The job is still ${job.state} after ${String(settings.waitTimeout)} s; it keeps running.`,
        resumeToken: settings.resumeToken,
      });
    }
    await sleepOrAbort(clock, Math.min(interval, remaining), signal);
    interval = Math.min(interval * POLL_FACTOR, POLL_CEILING_MS);
  }
}
