import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import { emitCatalog, emitHints, emitScopes } from "../scripts/generate.mjs";
import { HINTS } from "../src/generated/hints";

function committed(name: string): string {
  return readFileSync(new URL(`../src/generated/${name}`, import.meta.url), "utf8");
}

describe("generator", () => {
  it("reproduces the committed catalog and scopes from the committed spec", () => {
    expect(emitCatalog(spec)).toBe(committed("catalog.ts"));
    expect(emitScopes(spec)).toBe(committed("scopes.ts"));
  });
  it("reproduces the committed hints from their own table", () => {
    expect(emitHints(HINTS)).toBe(committed("hints.ts"));
  });
  it("keeps public hint copy free of em-dashes", () => {
    for (const text of Object.values(HINTS)) expect(text).not.toContain("—");
  });
  it("escapes quotes and newlines in emitted strings", () => {
    const out = emitHints({ a: 'say "hi"\nthen go' });
    expect(out).toContain(String.raw`"a": "say \"hi\"\nthen go",`);
  });
  it("rejects a catalog with a duplicate slug", () => {
    const entry = { code: 1000, slug: "bad_request", status: 400, meaning: "m" };
    expect(() => emitCatalog({ "x-error-catalog": [entry, entry] })).toThrow(
      /duplicate error slug/,
    );
  });
  it("rejects malformed catalog entries and missing catalogs", () => {
    expect(() => emitCatalog({})).toThrow(/no x-error-catalog/);
    expect(() =>
      emitCatalog({ "x-error-catalog": [{ slug: "a", code: "1", status: 400, meaning: "m" }] }),
    ).toThrow(/a\.code must be an integer/);
    expect(() =>
      emitCatalog({ "x-error-catalog": [{ slug: "", code: 1, status: 400, meaning: "m" }] }),
    ).toThrow(/slug must be a non-empty string/);
    expect(() => emitCatalog({ "x-error-catalog": [null] })).toThrow(/must be an object/);
  });
  it("skips operations without a scope and rejects an empty one", () => {
    const paths = { "/a": { get: { "x-required-scope": "s" }, post: {}, parameters: [] } };
    expect(emitScopes({ paths })).toContain('"GET /a": "s",');
    expect(emitScopes({ paths })).not.toContain("POST /a");
    expect(() => emitScopes({ paths: { "/a": { get: { "x-required-scope": "" } } } })).toThrow(
      /non-empty string/,
    );
  });
  it("rejects an empty hints table", () => {
    expect(() => emitHints({})).toThrow(/empty/);
  });
});
