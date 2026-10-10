import { afterEach, describe, expect, it, vi } from "vitest";
import * as fetchModule from "../src/http/fetch";
import { createTransport } from "../src/http/transport";
import { config, fakeClock } from "./helpers";
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

describe("transport retry selection and body ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["GET", "/v1/account"],
    ["POST", "/v1/uploads/job_1/complete"],
    ["PUT", "/v1/uploads"],
  ])("does not inspect the body of %s %s", async (method, path) => {
    const clone = vi.spyOn(Request.prototype, "clone");
    const wire = vi.fn((input: string | URL | Request) => {
      expect(input).toBeInstanceOf(Request);
      expect((input as Request).method).toBe(method);
      expect(new URL((input as Request).url).pathname).toBe(path);
      expect((input as Request).bodyUsed).toBe(false);
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.spyOn(fetchModule, "hardenedFetch").mockReturnValue(wire);
    const body = method === "GET" ? {} : { body: "payload" };
    const response = await createTransport(config(fakeClock()))(`https://example.com${path}`, {
      method,
      ...body,
    });
    expect(response.status).toBe(200);
    expect(clone).not.toHaveBeenCalled();
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it("classifies upload creation from a clone and leaves the sent body readable", async () => {
    const body = JSON.stringify({ idempotency_key: "0123456789abcdef", size_bytes: 100 });
    const wire = vi.fn(async (input: string | URL | Request) => {
      expect(input).toBeInstanceOf(Request);
      expect(await (input as Request).text()).toBe(body);
      return Response.json({ ok: true });
    });
    const hardened = vi.spyOn(fetchModule, "hardenedFetch").mockReturnValue(wire);
    const cfg = config(fakeClock());
    await createTransport(cfg)("https://example.com/v1/uploads?trace=1", { method: "POST", body });
    expect(hardened).toHaveBeenCalledWith(cfg, "upload-create");
    expect(wire).toHaveBeenCalledTimes(1);
  });
});
