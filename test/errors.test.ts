import { describe, expect, it } from "vitest";
import {
  AbortError,
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  DailyLimitError,
  FileLimitError,
  HushscriptError,
  InsufficientBalanceError,
  JobFailedError,
  NetworkError,
  NotFoundError,
  OutcomeUnknownError,
  PaymentMethodRequiredError,
  PermissionError,
  PreflightError,
  RateLimitError,
  ResumeMismatchError,
  UnsupportedMediaError,
  UploadError,
  ValidationError,
  WaitTimeoutError,
  errorFromResponse,
} from "../src/errors";
import { REDACTED } from "../src/redact";
import { TOKEN } from "./helpers";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("class tree (spec 9.2)", () => {
  const sdkInit = { code: "x", message: "m" };
  it("nests every class under HushscriptError the way the spec draws it", () => {
    const preflight = [
      new UnsupportedMediaError(sdkInit),
      new FileLimitError(sdkInit),
      new DailyLimitError(sdkInit),
      new ResumeMismatchError(sdkInit),
    ];
    for (const error of preflight) {
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toBeInstanceOf(HushscriptError);
      expect(error).toBeInstanceOf(Error);
    }
    const api = [
      new AuthenticationError({ ...sdkInit, status: 401 }),
      new PermissionError({ ...sdkInit, status: 403 }),
      new InsufficientBalanceError({ ...sdkInit, status: 402 }),
      new NotFoundError({ ...sdkInit, status: 404 }),
      new ConflictError({ ...sdkInit, status: 409 }),
      new ValidationError({ ...sdkInit, status: 422 }),
      new RateLimitError({ ...sdkInit, status: 429 }),
    ];
    for (const error of api) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(PreflightError);
    }
    const direct = [
      new ConfigurationError({ message: "m" }),
      new PaymentMethodRequiredError({ message: "m" }),
      new UploadError(sdkInit),
      new JobFailedError({ message: "m", error: "boom", failureKind: null, jobId: "job_1" }),
      new WaitTimeoutError({ message: "m", resumeToken: "tok" }),
      new AbortError({ message: "m" }),
      new NetworkError({ message: "m" }),
      new OutcomeUnknownError({ message: "m" }),
    ];
    for (const error of direct) {
      expect(error).toBeInstanceOf(HushscriptError);
      expect(error).not.toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(PreflightError);
    }
  });

  it("names each instance after its class", () => {
    expect(new RateLimitError({ ...sdkInit, status: 429 }).name).toBe("RateLimitError");
    expect(new ConfigurationError({ message: "m" }).name).toBe("ConfigurationError");
  });

  it("gives SDK-side classes their own slug and hint", () => {
    const config = new ConfigurationError({ message: "m" });
    expect(config.code).toBe("config_invalid");
    expect(config.numericCode).toBeNull();
    expect(config.status).toBeNull();
    expect(new PaymentMethodRequiredError({ message: "m" }).code).toBe("no_default_card");
    expect(new PaymentMethodRequiredError({ message: "m" }).hint).toContain(
      "hs.billing.addCardUrl()",
    );
    expect(new NetworkError({ message: "m" }).code).toBe("network_error");
    expect(new AbortError({ message: "m" }).code).toBe("aborted");
    expect(new OutcomeUnknownError({ message: "m" }).code).toBe("outcome_unknown");
    expect(new WaitTimeoutError({ message: "m", resumeToken: "t" }).code).toBe("wait_timeout");
    expect(
      new JobFailedError({ message: "m", error: null, failureKind: null, jobId: "j" }).code,
    ).toBe("job_failed");
  });

  it("carries the extra fields of JobFailedError, WaitTimeoutError and AbortError", () => {
    const failed = new JobFailedError({
      message: "m",
      error: "bad media",
      failureKind: "media_unreadable",
      jobId: "job_9",
    });
    expect([failed.error, failed.failureKind, failed.jobId]).toEqual([
      "bad media",
      "media_unreadable",
      "job_9",
    ]);
    expect(new WaitTimeoutError({ message: "m", resumeToken: "t" }).resumeToken).toBe("t");
    expect(new AbortError({ message: "m" }).resumeToken).toBeNull();
    expect(new AbortError({ message: "m", resumeToken: "r" }).resumeToken).toBe("r");
  });

  it("fills hints for SDK-side slugs from the shared table", () => {
    const daily = new DailyLimitError({
      code: "daily_limit",
      message: "m",
      hintValues: { used: 40, max: 60 },
    });
    expect(daily.hint).toBe(
      "This upload would pass your daily transcription limit (40 of 60 min used in the last 24 h).",
    );
    expect(new ResumeMismatchError({ code: "resume_file_mismatch", message: "m" }).hint).toContain(
      "not the file the upload started with",
    );
  });

  it("honors an explicit hint, including null", () => {
    expect(new UploadError({ code: "upload_incomplete", message: "m", hint: "custom" }).hint).toBe(
      "custom",
    );
    expect(new UploadError({ code: "unlisted", message: "m" }).hint).toBeNull();
    expect(
      new UploadError({ code: "unsupported_media", message: "m", hint: null }).hint,
    ).toBeNull();
  });

  it("explains an outcome that cannot be known (spec 7.4)", () => {
    const claim = new OutcomeUnknownError({
      message: "m",
      hint: OutcomeUnknownError.hintFor("POST /v1/agent/accounts/{signup_id}/claim"),
    });
    expect(claim.hint).toContain("Retrying will fail with agent_claim_invalid");
    expect(OutcomeUnknownError.hintFor("POST /v1/agent/credentials/rotate")).toContain(
      "The old token may already be revoked",
    );
    expect(OutcomeUnknownError.hintFor("POST /v1/agent/accounts")).toBeNull();
  });
});

describe("errorFromResponse", () => {
  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [402, InsufficientBalanceError],
    [403, PermissionError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ApiError],
    [502, ApiError],
    [418, ApiError],
  ])("maps status %i to %o", (status, expected) => {
    const error = errorFromResponse(
      res(status),
      { error: "some_unknown_slug", code: 9999 },
      "GET /v1/account",
    );
    expect(error).toBeInstanceOf(expected);
    expect(error.status).toBe(status);
    expect(error.constructor).toBe(expected);
  });

  it.each([
    ["rate_limited", 429, 5000, RateLimitError],
    ["too_many_active_jobs", 429, 5001, RateLimitError],
    ["agent_purchase_capped", 429, 4038, RateLimitError],
    ["url_target_busy", 429, 1042, RateLimitError],
    ["org_pool_expired", 402, 4026, InsufficientBalanceError],
    ["org_plan_frozen", 402, 4025, InsufficientBalanceError],
    ["org_insufficient_balance", 402, 3003, InsufficientBalanceError],
    ["pat_scope_missing", 403, 2023, PermissionError],
    ["pat_purchase_requires_app", 403, 4021, PermissionError],
    ["agent_claim_invalid", 401, 4036, AuthenticationError],
    ["wrong_state", 409, 4001, ConflictError],
    ["pat_limit", 409, 4022, ConflictError],
    ["upload_incomplete", 422, 1041, UploadError],
    ["size_exceeded", 422, 1024, UploadError],
  ])("maps the slug %s", (slug, status, numeric, expected) => {
    const error = errorFromResponse(res(status), { error: slug, code: numeric }, "GET /v1/account");
    expect(error.constructor).toBe(expected);
    expect(error.code).toBe(slug);
    expect(error.numericCode).toBe(numeric);
    expect(error.status).toBe(status);
  });

  it("lets a rate-limit slug win over an odd status", () => {
    expect(
      errorFromResponse(res(503), { error: "rate_limited", code: 5000 }, "GET /v1/jobs"),
    ).toBeInstanceOf(RateLimitError);
  });

  it("takes the message from the generated catalog", () => {
    const error = errorFromResponse(
      res(402),
      { error: "insufficient_balance", code: 3001 },
      "POST /v1/uploads",
    );
    expect(error.message).toMatch(/balance|minutes|credit/i);
    expect(error.message.length).toBeGreaterThan(20);
  });

  it("falls back to a plain message for an edge error that is not JSON", () => {
    const error = errorFromResponse(res(502), "Bad Gateway", "GET /v1/account");
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("http_502");
    expect(error.numericCode).toBeNull();
    expect(error.message).toContain("502");
  });

  it("falls back for a slug the catalog does not know", () => {
    const error = errorFromResponse(res(418), { error: "teapot", code: 1234 }, "GET /v1/account");
    expect(error.code).toBe("teapot");
    expect(error.numericCode).toBe(1234);
    expect(error.message).toContain("teapot");
  });

  it("ignores a body whose fields have the wrong types", () => {
    const error = errorFromResponse(res(500), { error: 5, code: "x" }, "GET /v1/account");
    expect(error.code).toBe("http_500");
    expect(error.numericCode).toBeNull();
  });

  it("exposes the extra body keys camelCased, nested keys too", () => {
    const error = errorFromResponse(
      res(402),
      {
        error: "insufficient_balance",
        code: 3001,
        needed_seconds: 21,
        balance_seconds: 10,
        held_seconds: 0,
        details: { allowed_packs: ["45min"], window_seconds: 86_400 },
      },
      "POST /v1/uploads",
    );
    expect(error.details).toEqual({
      neededSeconds: 21,
      balanceSeconds: 10,
      heldSeconds: 0,
      details: { allowedPacks: ["45min"], windowSeconds: 86_400 },
    });
  });

  it("reads retryAfter from the header, else from the body detail", () => {
    expect(
      errorFromResponse(
        res(429, { "retry-after": "61" }),
        { error: "rate_limited", code: 5000 },
        "GET /v1/account",
      ).retryAfter,
    ).toBe(61);
    expect(
      errorFromResponse(
        res(429),
        { error: "agent_purchase_capped", code: 4038, details: { retry_after_seconds: 900 } },
        "POST /v1/billing/purchase",
      ).retryAfter,
    ).toBe(900);
    expect(
      errorFromResponse(res(429), { error: "rate_limited", code: 5000 }, "GET /v1/account")
        .retryAfter,
    ).toBeNull();
    expect(
      errorFromResponse(
        res(429, { "retry-after": "soon" }),
        { error: "rate_limited", code: 5000 },
        "GET /v1/account",
      ).retryAfter,
    ).toBeNull();
  });

  it("names the missing scope in the hint", () => {
    const e = errorFromResponse(
      res(403),
      { error: "pat_scope_missing", code: 2023 },
      "POST /v1/billing/purchase",
    );
    expect(e.hint).toContain('"billing"');
    const other = errorFromResponse(
      res(403),
      { error: "pat_scope_missing", code: 2023 },
      "GET /v1/transcripts/tr_123",
    );
    expect(other.hint).toContain('"transcripts:read"');
  });

  it("fills the balance hint in minutes", () => {
    const error = errorFromResponse(
      res(402),
      { error: "insufficient_balance", code: 3001, needed_seconds: 1250, balance_seconds: 600 },
      "POST /v1/uploads",
    );
    expect(error.hint).toBe(
      'Not enough minutes: 21 needed, 10 available. Buy a pack with hs.buy("300min") or in the app.',
    );
  });

  it("fills retryAfter and allowedPacks placeholders", () => {
    expect(
      errorFromResponse(
        res(429, { "retry-after": "30" }),
        { error: "rate_limited", code: 5000 },
        "GET /v1/jobs",
      ).hint,
    ).toBe(
      "Too many requests. The SDK already waited and retried; slow down or try again in 30 s.",
    );
    expect(
      errorFromResponse(
        res(403),
        { error: "agent_pack_locked", code: 4037, details: { allowed_packs: ["45min", "300min"] } },
        "POST /v1/billing/purchase",
      ).hint,
    ).toBe("New agent accounts can buy 45min, 300min until earlier purchases settle.");
  });

  it("drops a hint clause whose value is unknown instead of printing a placeholder", () => {
    const limited = errorFromResponse(
      res(429),
      { error: "rate_limited", code: 5000 },
      "GET /v1/jobs",
    );
    expect(limited.hint).toBe("Too many requests. The SDK already waited and retried.");
    const capped = errorFromResponse(
      res(429),
      { error: "agent_purchase_capped", code: 4038 },
      "POST /v1/billing/purchase",
    );
    expect(capped.hint).toBe(
      "This account has used its 3 purchase attempts for the last 24 hours.",
    );
    const locked = errorFromResponse(
      res(403),
      { error: "agent_pack_locked", code: 4037 },
      "POST /v1/billing/purchase",
    );
    expect(locked.hint).toBeNull();
    const poor = errorFromResponse(
      res(402),
      { error: "insufficient_balance", code: 3001 },
      "POST /v1/uploads",
    );
    expect(poor.hint).toBe('Buy a pack with hs.buy("300min") or in the app.');
    for (const e of [limited, capped, poor]) expect(e.hint).not.toMatch(/[{}]/);
  });

  it("has no hint for a slug that is not in the shared table", () => {
    expect(
      errorFromResponse(res(404), { error: "job_not_found", code: 1100 }, "GET /v1/jobs/j").hint,
    ).toBeNull();
  });

  it("never lets the token into message, hint, details or cause", () => {
    const error = errorFromResponse(
      res(401),
      { error: "unauthorized", code: 2000, details: { echoed: TOKEN }, extra_note: `t=${TOKEN}` },
      "GET /v1/account",
    );
    const surfaces = [
      error.message,
      String(error.hint),
      JSON.stringify(error.details),
      String(error),
    ];
    for (const text of surfaces) expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(error.details)).toContain(REDACTED);
    const wrapped = new NetworkError({
      message: `lost ${TOKEN}`,
      cause: new Error(`inner ${TOKEN}`),
    });
    expect(wrapped.message).not.toContain(TOKEN);
    expect((wrapped.cause as Error).message).not.toContain(TOKEN);
  });
});
