import type { Client } from "openapi-fetch";
import type { components, paths } from "../generated/schema";
import { paginate, type Page } from "../paginate.ts";
import { Transcript } from "../transcript.ts";
import { present } from "../transcribe/common.ts";
import { invalidOption } from "../transcribe/preflight.ts";

export interface TranscriptSummary {
  id: string;
  title: string;
  language: string | null;
  durationSeconds: number;
  createdAt: Date;
  autoDeleteAt: Date | null;
  tags: string[];
}

/** The record kept after a transcript was removed; its content is gone. */
export interface DeletedTranscript {
  id: string;
  title: string;
  durationSeconds: number;
  /** When the transcript was uploaded. */
  createdAt: Date;
  deletedAt: Date;
  /** A cause the SDK does not know yet passes through as the API's own string. */
  cause: "manual" | "scheduled" | "dormant" | "expired" | (string & Record<never, never>);
  /** The stored deletion receipt, opaque and as the API sends it (snake_case keys, string timestamps); null when it could not be read back. */
  receipt: Record<string, unknown> | null;
}

export interface PageOptions {
  /** Rows per page; the API defaults to 50 and clamps at 100. */
  pageSize?: number | undefined;
  /** Stops the request in flight and, for `list()`, the walk between pages. */
  signal?: AbortSignal | undefined;
}

export interface PageRequest extends PageOptions {
  /** From a previous page's `nextCursor`; absent for the first page. */
  cursor?: string | undefined;
}

function date(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

function signalOf(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function query(options: PageRequest): { cursor?: string; limit?: number } {
  const out: { cursor?: string; limit?: number } = {};
  if (options.pageSize !== undefined) {
    if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
      throw invalidOption("pageSize must be a whole number of 1 or more.");
    }
    out.limit = options.pageSize;
  }
  if (options.cursor !== undefined) out.cursor = options.cursor;
  return out;
}

function summaryOf(row: components["schemas"]["TranscriptListRow"]): TranscriptSummary {
  return {
    id: row.id,
    title: row.title,
    language: row.language_detected,
    durationSeconds: row.duration_seconds,
    createdAt: date(row.created_at),
    autoDeleteAt: row.auto_delete_at === null ? null : date(row.auto_delete_at),
    tags: row.tags,
  };
}

function deletedOf(row: components["schemas"]["DeletedTranscript"]): DeletedTranscript {
  return {
    id: row.id,
    title: row.title,
    durationSeconds: row.duration_seconds,
    createdAt: date(row.created_at),
    deletedAt: date(row.deleted_at),
    cause: row.cause,
    receipt: row.receipt,
  };
}

export class TranscriptsResource {
  readonly #api: Client<paths>;

  constructor(api: Client<paths>) {
    this.#api = api;
  }

  /** Every finished transcript, newest first, fetching pages as it goes. Jobs still running are in `jobs.list({ active: true })`. */
  list(options: PageOptions = {}): AsyncIterable<TranscriptSummary> {
    query(options);
    return paginate(
      (cursor) => this.page({ ...options, ...(cursor === null ? {} : { cursor }) }),
      options.signal,
    );
  }

  /** One page of `list()`. */
  async page(options: PageRequest = {}): Promise<Page<TranscriptSummary>> {
    const { data } = await this.#api.GET("/v1/transcripts", {
      params: { query: query(options) },
      ...signalOf(options.signal),
    });
    const body = present(data, "GET /v1/transcripts");
    return { items: body.transcripts.map(summaryOf), nextCursor: body.next_cursor };
  }

  async get(id: string): Promise<Transcript> {
    const { data } = await this.#api.GET("/v1/transcripts/{id}", { params: { path: { id } } });
    return Transcript.fromApi(present(data, "GET /v1/transcripts/{id}"));
  }

  /** Deletion records, by upload time, newest first. */
  deleted(options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<DeletedTranscript> {
    return paginate(async (cursor) => {
      const { data } = await this.#api.GET("/v1/transcripts/deleted", {
        params: { query: cursor === null ? {} : { cursor } },
        ...signalOf(options.signal),
      });
      const body = present(data, "GET /v1/transcripts/deleted");
      return { items: body.deleted.map(deletedOf), nextCursor: body.next_cursor };
    }, options.signal);
  }
}
