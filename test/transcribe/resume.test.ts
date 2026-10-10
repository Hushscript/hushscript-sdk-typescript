import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigurationError, ResumeMismatchError } from "../../src/errors";
import {
  assertSameFile,
  decodeResumeToken,
  encodeResumeToken,
  fileRequired,
  jobMissing,
} from "../../src/transcribe/resume";

const state = {
  jobId: "job_1",
  idempotencyKey: "0123456789abcdef",
  size: 1000,
  durationSeconds: 21,
};

const encoded = (body: unknown): string => Buffer.from(JSON.stringify(body)).toString("base64url");

describe("resume token", () => {
  it("round-trips for arbitrary valid inputs", () => {
    fc.assert(
      fc.property(
        // "." and ".." are not path segments, so a job id can never be either.
        fc.string({ minLength: 1 }).filter((id) => id !== "." && id !== ".."),
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: 36_000 }),
        (jobId, idempotencyKey, size, durationSeconds) => {
          const original = { jobId, idempotencyKey, size, durationSeconds };
          expect(decodeResumeToken(encodeResumeToken(original))).toEqual(original);
        },
      ),
    );
  });

  it("is base64url JSON with the version and the four fields", () => {
    const token = encodeResumeToken(state);
    expect(token).toMatch(/^[\w-]+$/);
    expect(JSON.parse(Buffer.from(token, "base64url").toString())).toEqual({ v: 1, ...state });
  });

  it.each([
    "",
    null,
    42,
    false,
    {},
    "not base64 json!",
    Buffer.from("[]").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 2, ...state })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, size: 0 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, jobId: "" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, durationSeconds: "21" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, jobId: "j", size: 1 })).toString("base64url"),
    encoded(5),
    encoded("job_1"),
    encoded({ v: 1, ...state, idempotencyKey: 5 }),
    encoded({ v: 1, ...state, idempotencyKey: "" }),
    encoded({ v: 1, ...state, size: "1000" }),
    encoded({ v: 1, ...state, durationSeconds: 0 }),
    encoded({ v: 1, ...state, durationSeconds: -1 }),
  ])("rejects a malformed token (%#)", (token) => {
    let error: unknown;
    try {
      decodeResumeToken(token as string);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      code: "config_invalid",
      status: null,
      message: "The resume token is not valid.",
    });
  });

  it("accepts a one-byte file and a duration below one second", () => {
    const small = { ...state, size: 1, durationSeconds: 0.001 };
    expect(decodeResumeToken(encodeResumeToken(small))).toEqual(small);
  });

  it("refuses a file of a different size, and accepts the same size", () => {
    expect(() => {
      assertSameFile(state, 1000);
    }).not.toThrow();
    const error = (() => {
      try {
        assertSameFile(state, 999);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect(error).toMatchObject({
      code: "resume_file_mismatch",
      status: null,
      message: "The file is 999 bytes; the upload started with 1000 bytes.",
    });
    expect((error as ResumeMismatchError).hint).toContain("not the file the upload started with");
  });

  it("has an error for a missing file", () => {
    const error = fileRequired();
    expect(error).toBeInstanceOf(ResumeMismatchError);
    expect(error).toMatchObject({
      code: "resume_file_required",
      status: null,
      message: "The upload is not finished, so resuming needs the original file.",
    });
    expect(error.hint).toContain("Pass the original file");
  });

  it("has an error for a job that is gone", () => {
    expect(jobMissing()).toMatchObject({
      code: "resume_job_missing",
      status: null,
      message: "The job behind this resume token no longer exists, so it cannot be resumed.",
    });
  });
});
