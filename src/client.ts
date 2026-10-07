import { inspect } from "node:util";
import createClient, { type Client } from "openapi-fetch";
import { resolveConfig, type HushscriptOptions, type ResolvedConfig } from "./config.ts";
import type { paths } from "./generated/schema";
import { createTransport } from "./http/transport.ts";
import { REDACTED } from "./redact.ts";
import { AgentResource, agentStatic, type AgentStatic } from "./resources/agent.ts";
import { BillingResource, type BuyOptions, type Purchase } from "./resources/billing.ts";
import { JobsResource } from "./resources/jobs.ts";
import {
  readAccount,
  toAccount,
  toBalance,
  type Account,
  type Balance,
} from "./resources/account.ts";
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
  /** Packs, saved cards and purchase history. Buying also needs the token's own purchase switch and the account-wide one, both in the app under Account → MCP. */
  readonly billing: BillingResource;
  /** Calls an agent account makes with its own token. */
  readonly agent: AgentResource;
  /** Signup and claim for agent accounts: no token needed, so they are static. */
  static readonly agent: AgentStatic = agentStatic;
  readonly #config: ResolvedConfig;
  readonly #pipeline: Pipeline;

  constructor(options: HushscriptOptions = {}) {
    const config = resolveConfig(options);
    this.#config = config;
    Object.defineProperty(this, inspect.custom, { value: () => this.toString() });
    this.api = createClient<paths>({ baseUrl: config.baseUrl, fetch: createTransport(config) });
    this.api.use({
      onRequest: ({ request }) => {
        request.headers.set("authorization", config.authorization());
        request.headers.set("user-agent", config.userAgent);
      },
    });
    this.#pipeline = new Pipeline(config, this.api);
    this.jobs = new JobsResource(this.api, (id, options) => this.#pipeline.waitForJob(id, options));
    this.transcripts = new TranscriptsResource(this.api);
    this.billing = new BillingResource(this.api);
    this.agent = new AgentResource(this.api, config);
  }

  /** Uploads `file`, waits for the transcript and returns it. */
  transcribe(file: FileInput, options?: TranscribeOptions): Promise<Transcript> {
    return this.#pipeline.transcribe(file, options);
  }

  /** Finishes a transcription from the token an `AbortError`, `WaitTimeoutError` or `onResumeToken` gave. */
  resume(token: ResumeToken, file?: FileInput, options?: ResumeOptions): Promise<Transcript> {
    return this.#pipeline.resume(token, file, options);
  }

  /** Buys a pack with the saved default card and returns what the purchase left you with (alias of `hs.billing.buy`). */
  buy(packId: string, options?: BuyOptions): Promise<Purchase> {
    return this.billing.buy(packId, options);
  }

  /** What can be spent now. Held minutes are already deducted from it, so do not subtract them again. */
  async balance(): Promise<Balance> {
    return toBalance(await readAccount(this.api));
  }

  /** The account in camelCase: balance, holds, expiry, limits, `cardOnFile` and `dataRegion`. */
  async account(): Promise<Account> {
    return toAccount(await readAccount(this.api));
  }

  toJSON(): Record<string, unknown> {
    return { token: REDACTED, baseUrl: this.#config.baseUrl };
  }

  toString(): string {
    return `Hushscript ${JSON.stringify(this.toJSON())}`;
  }
}
