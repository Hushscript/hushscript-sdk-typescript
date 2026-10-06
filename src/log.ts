import { redact } from "./redact.ts";

export type LogLevel = "off" | "debug";

interface AttemptLog {
  method: string;
  /** `/v1/...` path without its query, or `r2:part/{n}` for direct storage URLs. */
  target: string;
  /** HTTP status, or a short label such as `network_error` or `timeout`. */
  status: number | string;
  attempt: number;
  durationMs: number;
  retryDelayMs: number | null;
}

export interface Logger {
  readonly enabled: boolean;
  attempt(entry: AttemptLog): void;
}

function formatAttempt(entry: AttemptLog): string {
  const parts = [
    "hushscript",
    entry.method,
    entry.target,
    `status=${String(entry.status)}`,
    `attempt=${String(entry.attempt)}`,
    `duration_ms=${String(entry.durationMs)}`,
  ];
  if (entry.retryDelayMs !== null) parts.push(`retry_in_ms=${String(entry.retryDelayMs)}`);
  return parts.join(" ");
}

function stderrSink(line: string): void {
  console.error(line);
}

/** Metadata only: no headers, query strings, bodies, titles or transcript text ever reach a line. */
export function createLogger(level: LogLevel, sink: (line: string) => void = stderrSink): Logger {
  return {
    enabled: level === "debug",
    attempt(entry: AttemptLog): void {
      if (level === "debug") sink(redact(formatAttempt(entry)));
    },
  };
}

/** What a request URL looks like in a log line. Storage URLs carry a signature, so only the part number shows. */
export function describeTarget(url: URL, apiOrigin: string): string {
  if (url.origin === apiOrigin && !url.pathname.startsWith("/__r2/")) return url.pathname;
  const last = url.pathname.split("/").at(-1) ?? "";
  return /^\d+$/.test(last) ? `r2:part/${last}` : "r2:part";
}
