import { inspect } from "node:util";
import createClient, { type Client } from "openapi-fetch";
import { resolveConfig, type HushscriptOptions, type ResolvedConfig } from "./config.ts";
import type { paths } from "./generated/schema";
import { hardenedFetch } from "./http/fetch.ts";
import { retryClassForRequest } from "./http/operations.ts";
import { REDACTED } from "./redact.ts";
import {
  Pipeline,
  type Job,
  type JobWaitOptions,
  type ResumeOptions,
  type ResumeToken,
  type TranscribeOptions,
  type Transcript,
} from "./transcribe/index.ts";
import type { FileInput } from "./transcribe/source.ts";

export class Hushscript {
  /** Every `/v1` operation, typed from the OpenAPI document, with the SDK's retries, timeouts and redaction. */
  readonly api: Client<paths>;
  /** Job helpers; `wait` polls until the job is done or failed. */
  readonly jobs: { wait(id: string, options?: JobWaitOptions): Promise<Job> };
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
    this.jobs = {
      wait: (id, options) => this.#pipeline.waitForJob(id, options),
    };
  }

  /** Uploads `file`, waits for the transcript and returns it (spec 6.1). */
  transcribe(file: FileInput, options?: TranscribeOptions): Promise<Transcript> {
    return this.#pipeline.transcribe(file, options);
  }

  /** Finishes a transcription from the token an `AbortError`, `WaitTimeoutError` or `onResumeToken` gave. */
  resume(token: ResumeToken, file?: FileInput, options?: ResumeOptions): Promise<Transcript> {
    return this.#pipeline.resume(token, file, options);
  }

  toJSON(): Record<string, unknown> {
    return { token: REDACTED, baseUrl: this.#config.baseUrl };
  }

  toString(): string {
    return `Hushscript ${JSON.stringify(this.toJSON())}`;
  }
}
