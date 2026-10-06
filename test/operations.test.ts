import { describe, expect, it } from "vitest";
import { operationFor, retryClassForRequest } from "../src/http/operations";

describe("operationFor", () => {
  it.each([
    ["GET", "/v1/account", "GET /v1/account"],
    ["get", "/v1/jobs/job_123", "GET /v1/jobs/{id}"],
    ["GET", "/v1/transcripts/deleted", "GET /v1/transcripts/deleted"],
    ["GET", "/v1/transcripts/tr_1", "GET /v1/transcripts/{id}"],
    ["PUT", "/v1/uploads/job_9/parts/3", "PUT /v1/uploads/{job}/parts/{n}"],
    ["POST", "/v1/agent/accounts/hsr1:eu:sg_1/claim", "POST /v1/agent/accounts/{signup_id}/claim"],
    ["POST", "/v1/billing/purchase", "POST /v1/billing/purchase"],
    ["GET", "/v1/unknown/thing", "GET /v1/unknown/thing"],
    ["GET", "/__r2/job/3", "GET /__r2/job/3"],
  ])("%s %s is %s", (method, path, expected) => {
    expect(operationFor(method, path)).toBe(expected);
  });

  it("does not let a trailing slash or extra segment match a template", () => {
    expect(operationFor("GET", "/v1/jobs/a/b")).toBe("GET /v1/jobs/a/b");
  });
});

describe("retryClassForRequest (spec 7.2)", () => {
  it.each<[string, string | null, string]>([
    [
      "a create with an idempotency key",
      '{"size_bytes":1,"idempotency_key":"0123456789abcdef"}',
      "upload-create",
    ],
    ["a create with an empty key", '{"size_bytes":1,"idempotency_key":""}', "mutate"],
    ["a create with a non-string key", '{"idempotency_key":7}', "mutate"],
    ["a create with no key", '{"size_bytes":1}', "mutate"],
    ["a create with a body that is not JSON", "not json", "mutate"],
    ["a create with a null body", "null", "mutate"],
    ["a create with no body", null, "mutate"],
  ])("%s is %s", (_name, body, expected) => {
    expect(retryClassForRequest("POST", "/v1/uploads", body)).toBe(expected);
  });

  it("leaves every other operation to its method and path", () => {
    expect(retryClassForRequest("GET", "/v1/account")).toBe("safe");
    expect(retryClassForRequest("POST", "/v1/uploads/job_1/complete")).toBe("idempotent");
    expect(retryClassForRequest("POST", "/v1/billing/purchase", "{}")).toBe("purchase");
  });
});
