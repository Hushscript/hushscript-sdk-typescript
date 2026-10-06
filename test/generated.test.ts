import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import { ERROR_CATALOG } from "../src/generated/catalog";
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
});
