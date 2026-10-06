import { describe, expect, it } from "vitest";
import { operationFor } from "../src/http/operations";

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
