import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";

describe("public entry", () => {
  it("exposes the client, the errors and the generated tables", () => {
    expect(Object.keys(sdk).sort()).toEqual(
      [
        "AbortError",
        "ApiError",
        "AuthenticationError",
        "ConfigurationError",
        "ConflictError",
        "DailyLimitError",
        "ERROR_CATALOG",
        "FileLimitError",
        "HINTS",
        "Hushscript",
        "HushscriptError",
        "InsufficientBalanceError",
        "JobFailedError",
        "NetworkError",
        "NotFoundError",
        "OPERATION_SCOPES",
        "OutcomeUnknownError",
        "PaymentMethodRequiredError",
        "PermissionDeniedError",
        "PreflightError",
        "RateLimitError",
        "ResumeMismatchError",
        "UnsupportedMediaError",
        "UploadError",
        "ValidationError",
        "WaitTimeoutError",
      ].sort(),
    );
  });
  it("keeps the catalog, hints and scopes non-empty", () => {
    expect(Object.keys(sdk.ERROR_CATALOG).length).toBeGreaterThan(0);
    expect(Object.keys(sdk.HINTS).length).toBeGreaterThan(0);
    expect(Object.keys(sdk.OPERATION_SCOPES).length).toBeGreaterThan(0);
  });
  it("constructs a client from the public entry", () => {
    const hs = new sdk.Hushscript({
      token: `hsr1:eu:pat.${"a".repeat(32)}.${"b".repeat(64)}`,
    });
    expect(typeof hs.api.GET).toBe("function");
  });
});
