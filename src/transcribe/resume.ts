import { ConfigurationError, ResumeMismatchError } from "../errors.ts";

/** Opaque base64url JSON `{v:1, jobId, idempotencyKey, size, durationSeconds}` (spec 6.1). */
export type ResumeToken = string;

export interface ResumeState {
  jobId: string;
  idempotencyKey: string;
  size: number;
  durationSeconds: number;
}

export function encodeResumeToken(state: ResumeState): ResumeToken {
  const body = {
    v: 1,
    jobId: state.jobId,
    idempotencyKey: state.idempotencyKey,
    size: state.size,
    durationSeconds: state.durationSeconds,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function invalid(): ConfigurationError {
  return new ConfigurationError({ message: "The resume token is not valid." });
}

export function decodeResumeToken(token: string): ResumeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid();
  const body = parsed as Record<string, unknown>;
  const { jobId, idempotencyKey, size, durationSeconds } = body;
  if (
    body["v"] !== 1 ||
    typeof jobId !== "string" ||
    jobId === "" ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey === "" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw invalid();
  }
  return { jobId, idempotencyKey, size, durationSeconds };
}

/** A replay with a different file silently returns the old job, so a size mismatch stops here, before any request. */
export function assertSameFile(state: ResumeState, size: number): void {
  if (size === state.size) return;
  throw new ResumeMismatchError({
    code: "resume_file_mismatch",
    message: `The file is ${String(size)} bytes; the upload started with ${String(state.size)} bytes.`,
  });
}

export function fileRequired(): ResumeMismatchError {
  return new ResumeMismatchError({
    code: "resume_file_required",
    message: "The upload is not finished, so resuming needs the original file.",
  });
}
