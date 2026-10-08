import type { Client } from "openapi-fetch";
import type { ResolvedConfig } from "../config.ts";
import { AbortError, ApiError, HushscriptError, UploadError, describeError } from "../errors.ts";
import type { paths } from "../generated/schema";
import { hardenedFetch } from "../http/fetch.ts";
import { MAX_PART_BYTES, PART_URLS } from "../shapes.ts";
import { aborted, readBody } from "./common.ts";
import type { Source } from "./source.ts";

/** Parts of a job with no direct plan: the API's own upper bound for a proxied part. */
const PROXIED_PART_BYTES = MAX_PART_BYTES;
/** Presigned URLs live 24 h; a page older than this is fetched again. */
const URL_MAX_AGE_MS = 23 * 3600 * 1000;

/** The direct-to-R2 plan from the create response, or null for a proxied job. */
interface UploadPlan {
  part_size_bytes: number;
  total_parts: number;
  /** `null`: the create says direct upload is not available, so every part goes through the API. */
  part_urls: { n: number; url: string }[] | null;
  next_part_number: number | null;
}

/** The part-urls answer; `null`, or a `null` part_urls, for a job that takes proxied parts only. */
type PartUrlsBody = {
  part_urls: { n: number; url: string }[] | null;
  next_part_number?: number | null;
} | null;

export interface PartAck {
  n: number;
  etag: string;
}

export interface UploadSettings {
  cfg: ResolvedConfig;
  api: Client<paths>;
  jobId: string;
  source: Source;
  plan: UploadPlan | null;
  concurrency: number;
  /** Aborts every in-flight part. */
  signal: AbortSignal;
  /** Called with the bytes acknowledged so far. */
  onAcked: (bytesSent: number) => void;
}

interface Page {
  start: number;
  urls: Map<number, string>;
  fetchedAt: number;
}

/** Presigned part URLs, 16 to a page, fetched on demand and again when expired. */
class PartUrls {
  readonly #api: Client<paths>;
  readonly #cfg: ResolvedConfig;
  readonly #jobId: string;
  readonly #signal: AbortSignal;
  readonly #pages: Page[] = [];
  readonly #inflight = new Map<number, Promise<boolean>>();
  #next: number | null;
  #direct = true;

  /** `signal` is the caller's and the upload's own failure signal combined, so a page fetch stops with the rest. */
  constructor(settings: UploadSettings, plan: UploadPlan, signal: AbortSignal) {
    this.#api = settings.api;
    this.#cfg = settings.cfg;
    this.#jobId = settings.jobId;
    this.#signal = signal;
    this.#next = plan.next_part_number;
    if (plan.part_urls === null) this.#direct = false;
    else if (plan.part_urls.length > 0) this.#store(plan.part_urls);
  }

  #store(urls: readonly { n: number; url: string }[]): number {
    const start = Math.min(...urls.map((entry) => entry.n));
    const page: Page = {
      start,
      urls: new Map(urls.map((entry) => [entry.n, entry.url])),
      fetchedAt: this.#cfg.clock.now(),
    };
    const at = this.#pages.findIndex((existing) => existing.start === start);
    if (at === -1) this.#pages.push(page);
    else this.#pages[at] = page;
    return start;
  }

  #pageOf(n: number): Page | undefined {
    return this.#pages.find((page) => page.urls.has(n));
  }

  /** One request per page start however many parts wait for it; false when the job has no direct URLs. */
  #fetchPage(start: number): Promise<boolean> {
    const running = this.#inflight.get(start);
    if (running !== undefined) return running;
    const request = (async (): Promise<boolean> => {
      const data = await readBody<PartUrlsBody>(
        this.#api.GET("/v1/uploads/{job}/part-urls", {
          params: { path: { job: this.#jobId }, query: { start } },
          signal: this.#signal,
          parseAs: "text",
        }),
        "GET /v1/uploads/{job}/part-urls",
        PART_URLS,
      );
      const urls = data?.part_urls ?? [];
      if (urls.length === 0) {
        this.#direct = false;
        return false;
      }
      const stored = this.#store(urls);
      if (this.#next === stored) this.#next = data?.next_part_number ?? null;
      return true;
    })().finally(() => {
      this.#inflight.delete(start);
    });
    this.#inflight.set(start, request);
    return request;
  }

  /** The URL for part `n`, or null when the job turns out to take proxied parts only. */
  async urlFor(n: number): Promise<string | null> {
    for (;;) {
      if (!this.#direct) return null;
      const page = this.#pageOf(n);
      if (page === undefined) {
        if (this.#next === null) {
          throw new UploadError({
            code: "part_url_missing",
            message: `No upload URL for part ${String(n)}.`,
          });
        }
        await this.#fetchPage(this.#next);
        continue;
      }
      if (this.#cfg.clock.now() - page.fetchedAt > URL_MAX_AGE_MS) {
        await this.#fetchPage(page.start);
        continue;
      }
      return page.urls.get(n) ?? null;
    }
  }

  /** Fetches the page `stale` came from again, unless another part already did. */
  async refresh(n: number, stale: string): Promise<void> {
    const page = this.#pageOf(n);
    if (page?.urls.get(n) !== stale) return;
    await this.#fetchPage(page.start);
  }
}

/** A 4xx other than 429 (which was already retried): the API said no, and trying again will not change it. */
function isTerminal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

function etagOf(response: Response): string {
  const etag = response.headers.get("etag")?.replaceAll('"', "") ?? "";
  if (etag === "") {
    throw new UploadError({
      code: "etag_missing",
      message: "Storage answered a part without an ETag.",
    });
  }
  return etag;
}

/** One part from the source; a read that fails is `source_read_failed`, which carries the key and token like any upload error. */
async function readPart(
  source: Source,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await source.read(offset, length, signal);
  } catch (error) {
    if (error instanceof HushscriptError) throw error;
    throw new UploadError({
      code: "source_read_failed",
      message: `Reading the input failed at byte ${String(offset)}, part way through the upload (${describeError(error)}).`,
      cause: error,
    });
  }
}

/**
 * Sends every part and returns the ETags to complete with, or null when the job went through the
 * API (`PUT .../parts/{n}`), whose complete call takes no body. Memory is bounded by
 * `concurrency` times the part size: each worker holds one part at a time.
 */
export async function uploadParts(settings: UploadSettings): Promise<PartAck[] | null> {
  const { cfg, jobId, source, plan } = settings;
  const partSize = plan?.part_size_bytes ?? PROXIED_PART_BYTES;
  if (!Number.isInteger(partSize) || partSize < 1) {
    throw new UploadError({
      code: "bad_part_plan",
      message: "The API returned an unusable part size.",
    });
  }
  const totalParts = Math.ceil(source.size / partSize);
  if (plan !== null && plan.total_parts !== totalParts) {
    throw new UploadError({
      code: "bad_part_plan",
      message: `The API planned ${String(plan.total_parts)} parts; the file needs ${String(totalParts)}.`,
    });
  }
  const failure = new AbortController();
  const signal = AbortSignal.any([settings.signal, failure.signal]);
  const urls = plan === null ? null : new PartUrls(settings, plan, signal);
  const putFetch = hardenedFetch(cfg, "idempotent", { timeoutMs: cfg.partTimeoutMs });
  const proxiedUrl = (n: number): string =>
    `${cfg.baseUrl}/v1/uploads/${encodeURIComponent(jobId)}/parts/${String(n)}`;

  const acks = new Map<number, string>();
  let proxied = plan === null;
  // Read through a call: the compiler would otherwise carry a `proxied` check across an await.
  const isProxied = (): boolean => proxied;
  // Read through a call for the same reason: an await may have moved the signal since the last check.
  const isAborted = (): boolean => signal.aborted;
  let directSucceeded = false;
  let sent = 0;
  let nextPart = 1;
  const outcome: { failed: boolean; error?: unknown } = { failed: false };

  const putDirect = async (url: string, bytes: Uint8Array): Promise<string> => {
    const response = await putFetch(url, {
      method: "PUT",
      body: bytes as NonNullable<RequestInit["body"]>,
      signal,
    });
    return etagOf(response);
  };

  const putProxied = async (n: number, bytes: Uint8Array): Promise<void> => {
    await putFetch(proxiedUrl(n), {
      method: "PUT",
      headers: {
        authorization: cfg.authorization(),
        "user-agent": cfg.userAgent,
        "content-type": "application/octet-stream",
      },
      body: bytes as NonNullable<RequestInit["body"]>,
      signal,
    });
  };

  /**
   * A failed direct attempt, whether the PUT or the part-urls fetch behind it: a 403, or
   * any failure once a direct PUT has succeeded, gets one fresh page; after that the job falls back
   * to proxied parts if no direct PUT ever succeeded, and raises `parts_exhausted` if one did.
   */
  const recover = async (
    pages: PartUrls,
    error: unknown,
    n: number,
    url: string | null,
    state: { refetched: boolean },
  ): Promise<void> => {
    const retryable =
      error instanceof HushscriptError &&
      !(error instanceof AbortError) &&
      !(error instanceof UploadError && error.code === "part_url_missing");
    if (!retryable || isAborted()) throw error;
    // The part-urls fetch itself was refused for a reason a fresh page or proxied parts cannot fix.
    if (url === null && directSucceeded && isTerminal(error)) throw error;
    let cause: HushscriptError = error;
    const forbidden = error instanceof ApiError && error.status === 403;
    if (url !== null && !state.refetched && (forbidden || directSucceeded)) {
      state.refetched = true;
      try {
        await pages.refresh(n, url);
        return;
      } catch (refreshError) {
        if (
          !(refreshError instanceof HushscriptError) ||
          refreshError instanceof AbortError ||
          isAborted() ||
          (directSucceeded && isTerminal(refreshError))
        )
          throw refreshError;
        cause = refreshError;
      }
    }
    if (!directSucceeded) {
      proxied = true;
      return;
    }
    throw new UploadError({
      code: "parts_exhausted",
      message: `Part ${String(n)} failed after retries and a fresh URL.`,
      cause,
    });
  };

  /** Direct first; a part that fails keeps the fallback rules. */
  const sendDirect = async (n: number, bytes: Uint8Array): Promise<void> => {
    const state = { refetched: false };
    while (!isProxied() && urls !== null) {
      let url: string | null;
      try {
        url = await urls.urlFor(n);
      } catch (error) {
        await recover(urls, error, n, null, state);
        continue;
      }
      if (url === null) {
        if (directSucceeded) {
          throw new UploadError({
            code: "part_url_missing",
            message: `No upload URL for part ${String(n)}.`,
          });
        }
        proxied = true;
        return;
      }
      try {
        const etag = await putDirect(url, bytes);
        if (isProxied()) return;
        directSucceeded = true;
        acks.set(n, etag);
        return;
      } catch (error) {
        await recover(urls, error, n, url, state);
      }
    }
  };

  const sendPart = async (n: number, bytes: Uint8Array): Promise<void> => {
    if (!isProxied()) await sendDirect(n, bytes);
    if (isProxied()) {
      acks.delete(n);
      await putProxied(n, bytes);
    }
  };

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const n = nextPart;
      nextPart += 1;
      if (n > totalParts) return;
      const offset = (n - 1) * partSize;
      const bytes = await readPart(source, offset, partSize, signal);
      await sendPart(n, bytes);
      sent += bytes.byteLength;
      settings.onAcked(sent);
    }
  };

  const guarded = async (): Promise<void> => {
    try {
      await worker();
    } catch (error) {
      if (!outcome.failed) Object.assign(outcome, { failed: true, error });
      failure.abort();
    }
  };

  const workers = source.sequential ? 1 : Math.min(settings.concurrency, totalParts);
  await Promise.all(Array.from({ length: workers }, guarded));
  if (outcome.failed) throw outcome.error;
  if (settings.signal.aborted) throw aborted(settings.signal);
  if (isProxied()) return null;
  return [...acks.entries()].sort(([a], [b]) => a - b).map(([n, etag]) => ({ n, etag }));
}
