import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactCause, redactValue, registerSecret } from "../src/redact";
import { TOKEN } from "./helpers";

describe("redact", () => {
  it("replaces anything shaped like a token", () => {
    expect(redact(`bad token ${TOKEN}, retry`)).toBe(`bad token ${REDACTED}, retry`);
    expect(REDACTED).toBe("hsr…[redacted]");
  });

  it("replaces every occurrence", () => {
    expect(redact(`${TOKEN} ${TOKEN}`)).toBe(`${REDACTED} ${REDACTED}`);
  });

  it("matches other regions and versions of the format", () => {
    expect(redact("hsr12:us:pat.ab12.cd34")).toBe(REDACTED);
  });

  it("leaves text without a token alone", () => {
    expect(redact("hsr is a prefix, pat.abc is not a token")).toBe(
      "hsr is a prefix, pat.abc is not a token",
    );
  });

  it("replaces a registered secret even when its format changes", () => {
    const odd = "hsr2~opaque-new-format-0123456789";
    registerSecret(odd);
    expect(redact(`Authorization: Bearer ${odd}`)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact(`?t=${encodeURIComponent(odd)}`)).toBe(`?t=${REDACTED}`);
  });

  it("ignores secrets too short to be one", () => {
    registerSecret("abc");
    expect(redact("abc abc")).toBe("abc abc");
  });

  it("walks values: strings, arrays, objects", () => {
    const value = { a: TOKEN, b: [TOKEN, 1, null, true], c: { d: `x ${TOKEN}` }, n: 3 };
    expect(redactValue(value)).toEqual({
      a: REDACTED,
      b: [REDACTED, 1, null, true],
      c: { d: `x ${REDACTED}` },
      n: 3,
    });
  });

  it("copies an Error cause with a redacted message, stack and code", () => {
    const cause = Object.assign(new TypeError(`connect failed for ${TOKEN}`), {
      code: "ECONNRESET",
    });
    const out = redactCause(cause);
    expect(out).toBeInstanceOf(Error);
    const text = JSON.stringify({ m: (out as Error).message, s: (out as Error).stack });
    expect(text).not.toContain(TOKEN);
    expect((out as Error & { code: string }).code).toBe("ECONNRESET");
    expect((out as Error).name).toBe("TypeError");
  });

  it("redacts the cause of a cause and passes non-errors through redactValue", () => {
    const inner = new Error(`inner ${TOKEN}`);
    const outer = new Error("outer", { cause: inner });
    const out = redactCause(outer) as Error;
    expect((out.cause as Error).message).not.toContain(TOKEN);
    expect(redactCause(`s ${TOKEN}`)).toBe(`s ${REDACTED}`);
    expect(redactCause(undefined)).toBeUndefined();
  });

  it("never lets a token-shaped string through, wherever it sits", () => {
    const hex = fc.stringMatching(/^[0-9a-f]{1,70}$/);
    fc.assert(
      fc.property(
        fc.nat(99),
        fc.stringMatching(/^[a-z]{1,8}$/),
        hex,
        hex,
        fc.string(),
        fc.string(),
        (version, region, id, secret, before, after) => {
          const token = `hsr${String(version)}:${region}:pat.${id}.${secret}`;
          expect(redact(`${before} ${token} ${after}`)).not.toContain(token);
        },
      ),
    );
  });
});
