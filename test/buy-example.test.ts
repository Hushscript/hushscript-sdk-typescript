import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKEN } from "./helpers";

const KEY = "purchase-example-retry-key";
const REQUEST_KEY_PREFIX = "purchase idempotency_key: ";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("buy example refusals (R80)", () => {
  it.each<[string, number | null, number | null, boolean]>([
    ["bare 403", 403, null, true],
    ["other 403", 403, 2013, true],
    ["403/4021", 403, 4021, false],
    ["403/4023", 403, 4023, false],
    ["401", 401, 2000, true],
    ["429", 429, 1006, true],
    ["400", 400, null, false],
    ["402", 402, null, false],
    ["404", 404, null, false],
    ["422", 422, null, false],
    ["500", 500, null, true],
    ["2xx bad_response", 200, null, true],
    ["network failure after send", null, null, true],
  ])("uses the correct retry-key path for %s", (_name, status, numericCode, mayHaveCharged) => {
    const bootstrap = `
      process.argv = [process.execPath, "examples/buy.ts", "300min", "--yes", "--key", ${JSON.stringify(KEY)}];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        let body;
        if (path === "/v1/billing/packs") {
          body = { packs: [{ id: "300min", seconds: 18000, amount: 3499, currency: "USD", referral_bonus_seconds: 0 }] };
        } else if (path === "/v1/billing/cards") {
          body = { default_id: "pm_1", methods: [] };
        } else if (path === "/v1/billing/purchase") {
          const purchaseBody = await request.json();
          console.log(${JSON.stringify(REQUEST_KEY_PREFIX)} + JSON.stringify(purchaseBody.idempotency_key));
          if (${JSON.stringify(status)} === null) {
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
            });
          }
          return Response.json(${JSON.stringify(status)} === 200 ? {} : { error: "purchase_failed", code: ${JSON.stringify(numericCode)} }, { status: ${JSON.stringify(status)} });
        } else {
          throw new Error("unexpected request: " + path);
        }
        return Response.json(body);
      };
      await import("./examples/buy.ts");
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "./scripts/examples-register.mjs",
        "--input-type=module",
        "--eval",
        bootstrap,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          HUSHSCRIPT_TOKEN: TOKEN,
          HUSHSCRIPT_BASE_URL: "http://127.0.0.1:4010",
          HUSHSCRIPT_LOG: "off",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    const requestKeys = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(REQUEST_KEY_PREFIX))
      .map((line) => JSON.parse(line.slice(REQUEST_KEY_PREFIX.length)) as unknown);
    expect(requestKeys.length).toBeGreaterThan(0);
    for (const requestKey of requestKeys) expect(requestKey).toBe(KEY);
    expect(result.stdout).toContain(
      status === null ? "network_error:" : status === 200 ? "bad_response:" : "purchase_failed:",
    );
    const warning = `The card may have been charged. Retry with: --key ${KEY}`;
    if (mayHaveCharged) expect(result.stdout).toContain(warning);
    else expect(result.stdout).not.toContain("The card may have been charged.");
  });
});
