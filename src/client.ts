import { inspect } from "node:util";
import createClient, { type Client } from "openapi-fetch";
import { resolveConfig, type HushscriptOptions, type ResolvedConfig } from "./config.ts";
import type { paths } from "./generated/schema";
import { hardenedFetch } from "./http/fetch.ts";
import { retryClassForRequest } from "./http/operations.ts";
import { REDACTED } from "./redact.ts";
import { JobsResource } from "./resources/jobs.ts";
import { readAccount, toBalance, type Account, type Balance } from "./resources/account.ts";
import { TranscriptsResource } from "./resources/transcripts.ts";
import {
  Pipeline,
  type ResumeOptions,
  type ResumeToken,
  type TranscribeOptions,
} from "./transcribe/index.ts";
import type { FileInput } from "./transcribe/source.ts";
import type { Transcript } from "./transcript.ts";

export class Hushscript {
  /** Every `/v1` operation, typed from the OpenAPI document, with the SDK's retries, timeouts and redaction. */
  readonly api: Client<paths>;
  /** Jobs, including those still processing; `wait` polls until one is done or failed. */
  readonly jobs: JobsResource;
  /** Finished transcripts: list, read and the deletion records. */
  readonly transcripts: TranscriptsResource;
  readonly #config: ResolvedConfig;
  readonly #pipeline: Pipeline;

  constructor(options: HushscriptOptions = {}) {
    const config = resolveConfig(options);
    this.#config = config;
    Object.defineProperty(this, inspect.custom, { value: () => this.toString() });
    // The class comes from the request's method and real URL, so a path a caller spelled out or a
    // middleware that swapped the Request still gets the right policy.
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      // Only an upload create needs its body looked at: its retry class depends on the key.
      const body =
        request.method.toUpperCase() === "POST" && pathname === "/v1/uploads"
          ? await request.clone().text()
          : null;
      return hardenedFetch(config, retryClassForRequest(request.method, pathname, body))(request);
    };
    this.api = createClient<paths>({ baseUrl: config.baseUrl, fetch: transport });
    this.api.use({
      onRequest: ({ request }) => {
        request.headers.set("authorization", config.authorization());
        request.headers.set("user-agent", config.userAgent);
      },
    });
    this.#pipeline = new Pipeline(config, this.api);
    this.jobs = new JobsResource(this.api, (id, options) => this.#pipeline.waitForJob(id, options));
    this.transcripts = new TranscriptsResource(this.api);
  }

  /** Uploads `file`, waits for the transcript and returns it (spec 6.1). */
  transcribe(file: FileInput, options?: TranscribeOptions): Promise<Transcript> {
    return this.#pipeline.transcribe(file, options);
  }

  /** Finishes a transcription from the token an `AbortError`, `WaitTimeoutError` or `onResumeToken` gave. */
  resume(token: ResumeToken, file?: FileInput, options?: ResumeOptions): Promise<Transcript> {
    return this.#pipeline.resume(token, file, options);
  }

  /** What can be spent now. Held minutes are already deducted from it, so do not subtract them again. */
  async balance(): Promise<Balance> {
    return toBalance(await readAccount(this.api));
  }

  /** The full `GET /v1/account` body: balance, limits, `card_on_file` and `data_region`. */
  account(): Promise<Account> {
    return readAccount(this.api);
  }

  toJSON(): Record<string, unknown> {
    return { token: REDACTED, baseUrl: this.#config.baseUrl };
  }

  toString(): string {
    return `Hushscript ${JSON.stringify(this.toJSON())}`;
  }
}
