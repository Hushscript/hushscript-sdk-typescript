import { inspect } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { systemClock, type Clock } from "./clock.ts";
import { ConfigurationError } from "./errors.ts";
import { TokenBucket } from "./http/pacing.ts";
import { createLogger, type LogLevel, type Logger } from "./log.ts";
import { REDACTED, registerSecret } from "./redact.ts";

const DEFAULT_BASE_URL = "https://api.hushscript.com";
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_RETRIES = 3;
const PART_TIMEOUT_MS = 300_000;
const CREATES_PER_WINDOW = 4;
const CREATE_WINDOW_MS = 60_000;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface HushscriptOptions {
  /** Falls back to HUSHSCRIPT_TOKEN. */
  token?: string | undefined;
  /** Falls back to HUSHSCRIPT_BASE_URL, then the production host. */
  baseUrl?: string | undefined;
  /** Seconds per request; default 60, at most 3600. */
  timeout?: number | undefined;
  /** Retries after the first attempt, per request; default 3. */
  maxRetries?: number | undefined;
  /** Falls back to HUSHSCRIPT_LOG, then "off". */
  logLevel?: LogLevel | undefined;
  /** Lets the client be constructed where `window` and `document` exist (tests only). */
  dangerouslyAllowBrowser?: boolean | undefined;
  clock?: Clock | undefined;
}

/** What a call that needs no token (agent signup and claim) can configure. */
export interface TokenlessOptions {
  /** Falls back to HUSHSCRIPT_BASE_URL, then the production host. */
  baseUrl?: string | undefined;
}

/** Hooks for tests; not part of the public options. */
export interface ConfigInternals {
  env?: Record<string, string | undefined>;
  random?: () => number;
  logSink?: (line: string) => void;
}

export interface ConfigValues {
  baseUrl: string;
  timeoutMs: number;
  partTimeoutMs: number;
  maxRetries: number;
  logLevel: LogLevel;
  clock: Clock;
  logger: Logger;
  random: () => number;
  createPacer: TokenBucket;
  userAgent: string;
}

/** Validated options. The token is reachable only through `authorization()` and never printed. */
export class ResolvedConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Per upload part PUT; not configurable. */
  readonly partTimeoutMs: number;
  readonly maxRetries: number;
  readonly logLevel: LogLevel;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly random: () => number;
  /** Paces `POST /v1/uploads` for this client instance. */
  readonly createPacer: TokenBucket;
  readonly userAgent: string;
  #token: string | null;

  constructor(token: string | null, values: ConfigValues) {
    this.#token = token;
    Object.defineProperty(this, inspect.custom, { value: () => this.toString() });
    this.baseUrl = values.baseUrl;
    this.timeoutMs = values.timeoutMs;
    this.partTimeoutMs = values.partTimeoutMs;
    this.maxRetries = values.maxRetries;
    this.logLevel = values.logLevel;
    this.clock = values.clock;
    this.logger = values.logger;
    this.random = values.random;
    this.createPacer = values.createPacer;
    this.userAgent = values.userAgent;
  }

  authorization(): string {
    if (this.#token === null) throw ConfigurationError.missingToken();
    return `Bearer ${this.#token}`;
  }

  /** Replaces the token for every later request (token rotation); the new one is redacted from then on. */
  setToken(token: string): void {
    registerSecret(token);
    this.#token = checkToken(token);
  }

  toJSON(): Record<string, unknown> {
    return {
      token: REDACTED,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      logLevel: this.logLevel,
    };
  }

  toString(): string {
    return `ResolvedConfig ${JSON.stringify(this.toJSON())}`;
  }
}

function runtime(): string {
  const deno = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno;
  if (deno?.version?.deno !== undefined) return `deno/${deno.version.deno}`;
  const bun = process.versions["bun"];
  if (bun !== undefined) return `bun/${bun}`;
  return `node/${process.versions.node}`;
}

function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError({ message: "baseUrl is not a valid URL." });
  }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new ConfigurationError({
      message: "baseUrl must be https://, or http:// to localhost, 127.0.0.1 or [::1].",
    });
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    throw new ConfigurationError({ message: "baseUrl must not have a path, query or fragment." });
  }
  return raw.replace(/\/+$/, "");
}

function isBrowser(): boolean {
  return (
    (globalThis as { window?: unknown }).window !== undefined &&
    (globalThis as { document?: unknown }).document !== undefined
  );
}

function checkLogLevel(raw: string): LogLevel {
  if (raw === "off" || raw === "debug") return raw;
  throw new ConfigurationError({ message: 'The log level must be "off" or "debug".' });
}

function refuseBrowser(allowed: boolean | undefined): void {
  if (isBrowser() && allowed !== true) {
    throw new ConfigurationError({
      message:
        "The Hushscript SDK refuses to run in a browser: a token in a browser bundle is a leaked token. Call it from a server.",
    });
  }
}

export function checkToken(raw: string): string {
  const token = raw.trim();
  if (token === "") throw ConfigurationError.missingToken();
  if (!token.startsWith("hsr")) {
    throw new ConfigurationError({ message: "This doesn't look like a Hushscript token." });
  }
  if (!/^[\u0021-\u007e]+$/u.test(token)) {
    throw new ConfigurationError({
      message:
        "The token has spaces, control characters or non-ASCII characters in it; check how it was copied.",
    });
  }
  return token;
}

function build(
  token: string | null,
  options: HushscriptOptions,
  env: Record<string, string | undefined>,
  internals: ConfigInternals,
): ResolvedConfig {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ConfigurationError({ message: "timeout must be a positive number of seconds." });
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw new ConfigurationError({
      message: `timeout must be at most ${String(MAX_TIMEOUT_SECONDS)} seconds.`,
    });
  }
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ConfigurationError({ message: "maxRetries must be a whole number, 0 or more." });
  }
  const clock = options.clock ?? systemClock;
  const logLevel = checkLogLevel(options.logLevel ?? env["HUSHSCRIPT_LOG"] ?? "off");
  if (token !== null) registerSecret(token);
  return new ResolvedConfig(token, {
    baseUrl: checkBaseUrl(options.baseUrl ?? env["HUSHSCRIPT_BASE_URL"] ?? DEFAULT_BASE_URL),
    timeoutMs: timeout * 1000,
    partTimeoutMs: PART_TIMEOUT_MS,
    maxRetries,
    logLevel,
    clock,
    logger: createLogger(logLevel, internals.logSink),
    random: internals.random ?? Math.random,
    createPacer: new TokenBucket(CREATES_PER_WINDOW, CREATE_WINDOW_MS, clock),
    userAgent: `hushscript-typescript/${pkg.version} ${runtime()}`,
  });
}

export function resolveConfig(
  options: HushscriptOptions = {},
  internals: ConfigInternals = {},
): ResolvedConfig {
  const env = internals.env ?? process.env;
  refuseBrowser(options.dangerouslyAllowBrowser);
  const token = checkToken(options.token ?? env["HUSHSCRIPT_TOKEN"] ?? "");
  return build(token, options, env, internals);
}

/** The configuration for the calls that carry no token: agent signup and claim. */
export function resolveTokenlessConfig(
  options: TokenlessOptions = {},
  internals: ConfigInternals = {},
): ResolvedConfig {
  refuseBrowser(undefined);
  return build(null, options, internals.env ?? process.env, internals);
}
