import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";

describe("public entry", () => {
  it("exposes the generated tables and nothing else yet", () => {
    expect(Object.keys(sdk).sort()).toEqual(["ERROR_CATALOG", "HINTS", "OPERATION_SCOPES"]);
  });
  it("keeps the catalog, hints and scopes non-empty", () => {
    expect(Object.keys(sdk.ERROR_CATALOG).length).toBeGreaterThan(0);
    expect(Object.keys(sdk.HINTS).length).toBeGreaterThan(0);
    expect(Object.keys(sdk.OPERATION_SCOPES).length).toBeGreaterThan(0);
  });
});
