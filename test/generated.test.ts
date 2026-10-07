import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import { ERROR_CATALOG } from "../src/generated/catalog";
import { HINTS } from "../src/generated/hints";
import { OPERATION_SCOPES } from "../src/generated/scopes";

function declaresScope(operation: unknown): boolean {
  return (
    typeof operation === "object" &&
    operation !== null &&
    "x-required-scope" in operation &&
    Boolean(operation["x-required-scope"])
  );
}

describe("generated tables", () => {
  it("carries every catalog entry from the committed spec", () => {
    expect(Object.keys(ERROR_CATALOG).length).toBe(spec["x-error-catalog"].length);
    expect(ERROR_CATALOG["insufficient_balance"]?.code).toBe(3001);
  });
  it("maps every operation that declares a scope", () => {
    const declared = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.entries(ops as Record<string, unknown>)
        .filter(([, o]) => declaresScope(o))
        .map(([m]) => `${m.toUpperCase()} ${p}`),
    );
    expect(Object.keys(OPERATION_SCOPES).sort()).toEqual(declared.sort());
  });
  it("carries a hint for every slug of spec section 9.3", () => {
    const slugs = [
      "unauthorized",
      "pat_scope_missing",
      "insufficient_balance",
      "rate_limited",
      "too_many_active_jobs",
      "agent_purchase_capped",
      "agent_pack_locked",
      "pat_purchase_requires_app",
      "pat_purchase_requires_authentication",
      "no_default_card",
      "unsupported_media",
      "duration_unreadable",
      "duration_out_of_range",
      "size_out_of_range",
      "daily_limit",
      "policy_version_stale",
      "wrong_state",
      "resume_file_mismatch",
      "resume_file_required",
      "resume_job_missing",
      "stream_size_mismatch",
      "default_card_required",
    ];
    expect(Object.keys(HINTS).sort()).toEqual([...slugs].sort());
    expect(HINTS["resume_file_mismatch"]).toContain("not the file the upload started with");
    expect(HINTS["resume_file_required"]).toContain("Pass the original file to resume it");
    expect(HINTS["config_invalid"]).toBeUndefined();
  });
});
