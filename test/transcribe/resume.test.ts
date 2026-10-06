import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigurationError, ResumeMismatchError } from "../../src/errors";
import {
  assertSameFile,
  decodeResumeToken,
  encodeResumeToken,
  fileRequired,
} from "../../src/transcribe/resume";

const state = {
  jobId: "job_1",
  idempotencyKey: "0123456789abcdef",
  size: 1000,
  durationSeconds: 21,
};

describe("resume token", () => {
  it("round-trips for arbitrary valid inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
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
    "not base64 json!",
    Buffer.from("[]").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 2, ...state })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, size: 0 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, jobId: "" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, ...state, durationSeconds: "21" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, jobId: "j", size: 1 })).toString("base64url"),
  ])("rejects a malformed token (%#)", (token) => {
    expect(() => decodeResumeToken(token)).toThrow(ConfigurationError);
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
    expect((error as ResumeMismatchError).code).toBe("resume_file_mismatch");
    expect((error as ResumeMismatchError).hint).toContain("not the file the upload started with");
  });

  it("has an error for a missing file", () => {
    const error = fileRequired();
    expect(error.code).toBe("resume_file_required");
    expect(error.hint).toContain("Pass the original file");
  });
});
