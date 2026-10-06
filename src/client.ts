import { inspect } from "node:util";
import createClient, { type Client } from "openapi-fetch";
import { resolveConfig, type HushscriptOptions, type ResolvedConfig } from "./config.ts";
import type { paths } from "./generated/schema";
import { hardenedFetch } from "./http/fetch.ts";
import { retryClassForRequest } from "./http/operations.ts";
import { REDACTED } from "./redact.ts";

export class Hushscript {
  /** Every `/v1` operation, typed from the OpenAPI document, with the SDK's retries, timeouts and redaction. */
  readonly api: Client<paths>;
  readonly #config: ResolvedConfig;

  constructor(options: HushscriptOptions = {}) {
    const config = resolveConfig(options);
    this.#config = config;
    Object.defineProperty(this, inspect.custom, { value: () => this.toString() });
    // The class comes from the request's method and real URL, so a path a caller spelled out or a
    // middleware that swapped the Request still gets the right policy.
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const retryClass = retryClassForRequest(request.method, new URL(request.url).pathname);
      return hardenedFetch(config, retryClass)(request);
    };
    this.api = createClient<paths>({ baseUrl: config.baseUrl, fetch: transport });
    this.api.use({
      onRequest: ({ request }) => {
        request.headers.set("authorization", config.authorization());
        request.headers.set("user-agent", config.userAgent);
      },
    });
  }

  toJSON(): Record<string, unknown> {
    return { token: REDACTED, baseUrl: this.#config.baseUrl };
  }

  toString(): string {
    return `Hushscript ${JSON.stringify(this.toJSON())}`;
  }
}
