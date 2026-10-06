import { inspect } from "node:util";
import createClient, { type Client } from "openapi-fetch";
import { resolveConfig, type HushscriptOptions, type ResolvedConfig } from "./config.ts";
import type { paths } from "./generated/schema";
import { hardenedFetch } from "./http/fetch.ts";
import { retryClassFor, type RetryClass } from "./http/retry.ts";
import { REDACTED } from "./redact.ts";

export class Hushscript {
  /** Every `/v1` operation, typed from the OpenAPI document, with the SDK's retries, timeouts and redaction. */
  readonly api: Client<paths>;
  readonly #config: ResolvedConfig;

  constructor(options: HushscriptOptions = {}) {
    const config = resolveConfig(options);
    this.#config = config;
    Object.defineProperty(this, inspect.custom, { value: () => this.toString() });
    // The middleware sees the path template and the transport sees only the request, so the
    // middleware leaves the retry class here for the transport to pick up.
    const classes = new WeakMap<Request, RetryClass>();
    const transport: typeof fetch = (input, init) => {
      const tagged = input instanceof Request ? classes.get(input) : undefined;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const fallback = retryClassFor(method, "");
      return hardenedFetch(config, tagged ?? fallback)(input, init);
    };
    this.api = createClient<paths>({ baseUrl: config.baseUrl, fetch: transport });
    this.api.use({
      onRequest: ({ request, schemaPath }) => {
        request.headers.set("authorization", config.authorization());
        request.headers.set("user-agent", config.userAgent);
        classes.set(request, retryClassFor(request.method, schemaPath));
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
