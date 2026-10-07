import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { resolveConfig } from "../src/config";
import { ConfigurationError } from "../src/errors";
import { TOKEN, fakeClock } from "./helpers";

const NO_ENV: Record<string, string | undefined> = {};

function failure(run: () => unknown): ConfigurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected a ConfigurationError");
}

describe("construction", () => {
  const saved = process.env["HUSHSCRIPT_TOKEN"];
  beforeEach(() => {
    delete process.env["HUSHSCRIPT_TOKEN"];
  });
  afterEach(() => {
    if (saved !== undefined) process.env["HUSHSCRIPT_TOKEN"] = saved;
    vi.unstubAllGlobals();
  });

  it("refuses construction without a token and says where to get one", () => {
    expect(() => new Hushscript()).toThrow(/HUSHSCRIPT_TOKEN/);
    const error = failure(() => new Hushscript());
    expect(error.code).toBe("config_invalid");
    expect(error.numericCode).toBeNull();
    expect(error.status).toBeNull();
    expect(error.hint).toBe(
      "Set HUSHSCRIPT_TOKEN or pass a token. Create one in the Hushscript app: Account → MCP (app.hushscript.com/account/mcp).",
    );
  });

  it("reads the token from HUSHSCRIPT_TOKEN", () => {
    process.env["HUSHSCRIPT_TOKEN"] = TOKEN;
    expect(() => new Hushscript()).not.toThrow();
  });

  it("treats an empty token as missing and trims a pasted one", () => {
    expect(() => resolveConfig({ token: "" }, { env: NO_ENV })).toThrow(/HUSHSCRIPT_TOKEN/);
    expect(() => resolveConfig({ token: `  ${TOKEN}\n` }, { env: NO_ENV })).not.toThrow();
  });

  it("prefers the option over the environment", () => {
    const cfg = resolveConfig({ token: TOKEN }, { env: { HUSHSCRIPT_TOKEN: "hsr1:eu:pat.aa.bb" } });
    expect(cfg.authorization()).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects a token that does not start with hsr, without echoing it", () => {
    const secret = "sk_live_0123456789abcdefghij";
    const error = failure(() => resolveConfig({ token: secret }, { env: NO_ENV }));
    expect(error.message).toContain("doesn't look like a Hushscript token");
    expect(error.message).not.toContain(secret);
    expect(String(error.hint)).not.toContain(secret);
  });

  it.each([
    ["a line feed", "\n"],
    ["a carriage return", "\r"],
    ["a NUL", "\u0000"],
    ["a space", " "],
    ["a tab", "\t"],
    ["DEL", "\u007f"],
    ["a non-ASCII letter", "é"],
  ])("rejects a token with %s inside, without echoing it", (_label, char) => {
    const secret = `hsr1:eu:pat.00.00${char}zz-secretpart-abcdef`;
    const error = failure(() => resolveConfig({ token: secret }, { env: NO_ENV }));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.code).toBe("config_invalid");
    expect(error.message).not.toContain("secretpart");
    expect(String(error.hint)).not.toContain("secretpart");
    expect(JSON.stringify(error.details)).not.toContain("secretpart");
    expect(() => new Hushscript({ token: secret })).toThrow(ConfigurationError);
  });

  it("checks only the prefix of the token", () => {
    expect(() => resolveConfig({ token: "hsr9:moon:whatever" }, { env: NO_ENV })).not.toThrow();
  });

  it("never prints the token", () => {
    const hs = new Hushscript({ token: TOKEN });
    const everything = String(hs) + JSON.stringify(hs) + inspect(hs, { depth: 10 });
    expect(everything).not.toContain(TOKEN.slice(12));
    expect(everything).toContain("hsr…[redacted]");
    const cfg = resolveConfig({ token: TOKEN }, { env: NO_ENV });
    const printed = String(cfg) + JSON.stringify(cfg) + inspect(cfg, { depth: 10 });
    expect(printed).not.toContain(TOKEN.slice(12));
    expect(Object.values(cfg).join()).not.toContain(TOKEN.slice(12));
  });
});

describe("baseUrl", () => {
  it("defaults to the production host and strips a trailing slash", () => {
    expect(resolveConfig({ token: TOKEN }, { env: NO_ENV }).baseUrl).toBe(
      "https://api.hushscript.com",
    );
    expect(
      resolveConfig({ token: TOKEN, baseUrl: "https://example.org/" }, { env: NO_ENV }).baseUrl,
    ).toBe("https://example.org");
  });

  it("reads HUSHSCRIPT_BASE_URL and lets the option win", () => {
    const env = { HUSHSCRIPT_BASE_URL: "https://env.example.org" };
    expect(resolveConfig({ token: TOKEN }, { env }).baseUrl).toBe("https://env.example.org");
    expect(
      resolveConfig({ token: TOKEN, baseUrl: "https://opt.example.org" }, { env }).baseUrl,
    ).toBe("https://opt.example.org");
  });

  it.each(["http://localhost:4010", "http://127.0.0.1:4010", "http://[::1]:4010"])(
    "allows plain http to the loopback host %s",
    (baseUrl) => {
      expect(resolveConfig({ token: TOKEN, baseUrl }, { env: NO_ENV }).baseUrl).toBe(baseUrl);
    },
  );

  it.each([
    "http://api.hushscript.com",
    "http://localhost.evil.example",
    "ftp://example.org",
    "not a url",
    "api.hushscript.com",
  ])("rejects %s", (baseUrl) => {
    const error = failure(() => resolveConfig({ token: TOKEN, baseUrl }, { env: NO_ENV }));
    expect(error.message).toMatch(/baseUrl/);
  });
});

describe("limits", () => {
  it("defaults to 60 s per request and 3 retries", () => {
    const cfg = resolveConfig({ token: TOKEN }, { env: NO_ENV });
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.maxRetries).toBe(3);
  });

  it("takes timeout in seconds and maxRetries as given", () => {
    const cfg = resolveConfig({ token: TOKEN, timeout: 2.5, maxRetries: 0 }, { env: NO_ENV });
    expect(cfg.timeoutMs).toBe(2500);
    expect(cfg.maxRetries).toBe(0);
  });

  it("accepts a timeout of up to 3600 s and rejects more", () => {
    expect(resolveConfig({ token: TOKEN, timeout: 3600 }, { env: NO_ENV }).timeoutMs).toBe(
      3_600_000,
    );
    expect(() => resolveConfig({ token: TOKEN, timeout: 3600.5 }, { env: NO_ENV })).toThrow(
      /at most 3600/,
    );
    // setTimeout overflows above 2^31 ms and would fire at once.
    expect(() => resolveConfig({ token: TOKEN, timeout: 2_200_000 }, { env: NO_ENV })).toThrow(
      ConfigurationError,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects timeout %s", (timeout) => {
    expect(() => resolveConfig({ token: TOKEN, timeout }, { env: NO_ENV })).toThrow(/timeout/);
  });

  it.each([-1, 1.5, Number.NaN])("rejects maxRetries %s", (maxRetries) => {
    expect(() => resolveConfig({ token: TOKEN, maxRetries }, { env: NO_ENV })).toThrow(
      /maxRetries/,
    );
  });
});

describe("logging and clock", () => {
  it("is off by default, switched on by HUSHSCRIPT_LOG or logLevel", () => {
    expect(resolveConfig({ token: TOKEN }, { env: NO_ENV }).logLevel).toBe("off");
    expect(resolveConfig({ token: TOKEN }, { env: { HUSHSCRIPT_LOG: "debug" } }).logLevel).toBe(
      "debug",
    );
    expect(
      resolveConfig({ token: TOKEN, logLevel: "off" }, { env: { HUSHSCRIPT_LOG: "debug" } })
        .logLevel,
    ).toBe("off");
  });

  it("checks a replacement token like the first one, and keeps the old one when it is refused", () => {
    const cfg = resolveConfig({ token: TOKEN }, { env: NO_ENV });
    for (const bad of ["", "   ", "not-a-token", "hsr1:eu:has space"]) {
      expect(() => {
        cfg.setToken(bad);
      }).toThrow(ConfigurationError);
    }
    expect(cfg.authorization()).toBe(`Bearer ${TOKEN}`);
    cfg.setToken(`  ${TOKEN}x\n`);
    expect(cfg.authorization()).toBe(`Bearer ${TOKEN}x`);
  });

  it("lets every explicitly passed option beat its environment variable", () => {
    const env = {
      HUSHSCRIPT_TOKEN: "hsr1:eu:pat.env.env",
      HUSHSCRIPT_BASE_URL: "https://env.example.com",
      HUSHSCRIPT_LOG: "debug",
    };
    const cfg = resolveConfig(
      { token: TOKEN, baseUrl: "http://127.0.0.1:4010", logLevel: "off" },
      { env },
    );
    expect(cfg.authorization()).toBe(`Bearer ${TOKEN}`);
    expect(cfg.baseUrl).toBe("http://127.0.0.1:4010");
    expect(cfg.logLevel).toBe("off");
    expect(cfg.logger.enabled).toBe(false);
  });

  it("rejects an unknown log level", () => {
    expect(() => resolveConfig({ token: TOKEN }, { env: { HUSHSCRIPT_LOG: "trace" } })).toThrow(
      /log level/i,
    );
  });

  it("uses the injected clock", () => {
    const clock = fakeClock();
    expect(resolveConfig({ token: TOKEN, clock }, { env: NO_ENV }).clock).toBe(clock);
  });
});

describe("browser guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to run where window and document both exist", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const error = failure(() => new Hushscript({ token: TOKEN }));
    expect(error.message).toMatch(/browser/i);
  });

  it("allows it with dangerouslyAllowBrowser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new Hushscript({ token: TOKEN, dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it("does not mistake a lone window for a browser", () => {
    vi.stubGlobal("window", {});
    expect(() => new Hushscript({ token: TOKEN })).not.toThrow();
  });
});

describe("identification", () => {
  it("sends hushscript-typescript/<version> <runtime>/<version>", () => {
    const cfg = resolveConfig({ token: TOKEN }, { env: NO_ENV });
    expect(cfg.userAgent).toMatch(/^hushscript-typescript\/\d+\.\d+\.\d+ (node|bun|deno)\/\d/);
  });
});
