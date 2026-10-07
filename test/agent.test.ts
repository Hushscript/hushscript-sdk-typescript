import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import type { Clock } from "../src/clock";
import { resolveTokenlessConfig } from "../src/config";
import {
  ConfigurationError,
  ConflictError,
  OutcomeUnknownError,
  ValidationError,
} from "../src/errors";
import { REDACTED, redact } from "../src/redact";
import {
  BASE,
  LIMITS,
  TEST_TIMEOUT_SECONDS,
  TOKEN,
  fakeClock,
  networkError,
  stubFetch,
} from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Neither matches the usual token shape, so only a registered secret gets redacted.
const NEW_TOKEN = "hsr1:eu:rotated-token-not-in-the-usual-shape-0123456789";
const CLAIMED_TOKEN = "hsr1:eu:claimed-token-not-in-the-usual-shape-0123456789";
const SIGNUP = {
  email: "agent@example.com",
  pack: "45min",
  acceptTerms: "2026-10-01",
  agent: { name: "Scribe", platform: "custom" },
} as const;

const ACCOUNT_BODY = {
  balance_seconds: 60,
  held_seconds: 0,
  credits_expire_at: null,
  card_on_file: false,
  data_region: "eu",
  limits: LIMITS,
};

function client(): Hushscript {
  return new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock: fakeClock(),
    timeout: TEST_TIMEOUT_SECONDS,
  });
}

describe("Hushscript.agent.signup", () => {
  it("sends the signup without credentials and maps the answer", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          signup_id: "hsr1:eu:abc",
          claim_secret: "cs_secret",
          checkout_url: "https://checkout.example.com/pay/abc",
          pack: "45min",
          amount: 599,
          currency: "USD",
          expires_at: 1_760_001_800,
        },
      },
    ]);
    const result = await Hushscript.agent.signup({
      ...SIGNUP,
      agent: { ...SIGNUP.agent, contactUrl: "https://agent.example.com" },
      dataRegion: "eu",
      dryRun: true,
      baseUrl: BASE,
    });
    expect(result).toEqual({
      signupId: "hsr1:eu:abc",
      claimSecret: "cs_secret",
      checkoutUrl: "https://checkout.example.com/pay/abc",
      price: { amount: 599, currency: "USD", formatted: "$5.99" },
      expiresAt: new Date(1_760_001_800_000),
    });
    const request = stub.requests[0];
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("user-agent")).toMatch(/^hushscript-typescript\//);
    expect(new URL(request?.url ?? "").pathname).toBe("/v1/agent/accounts");
    expect(JSON.parse(stub.bodies[0] ?? "")).toEqual({
      contact_email: "agent@example.com",
      pack_id: "45min",
      accept_terms_version: "2026-10-01",
      agent: { name: "Scribe", platform: "custom", contact_url: "https://agent.example.com" },
      data_region: "eu",
      dry_run: true,
    });
  });

  it("leaves out the optional fields it was not given", async () => {
    const stub = stubFetch([{ status: 500, text: "x" }]);
    await Hushscript.agent.signup({ ...SIGNUP, baseUrl: BASE }).catch(() => undefined);
    expect(JSON.parse(stub.bodies[0] ?? "")).toEqual({
      contact_email: "agent@example.com",
      pack_id: "45min",
      accept_terms_version: "2026-10-01",
      agent: { name: "Scribe", platform: "custom" },
    });
  });

  it("refuses a signup without acceptTerms, at compile time and at run time, before any request", async () => {
    const stub = stubFetch([{ status: 200, body: {} }]);
    const attempts = [
      () =>
        Hushscript.agent.signup(
          // @ts-expect-error acceptTerms is required and is never defaulted
          { email: SIGNUP.email, pack: SIGNUP.pack, agent: SIGNUP.agent, baseUrl: BASE },
        ),
      () => Hushscript.agent.signup({ ...SIGNUP, acceptTerms: "", baseUrl: BASE }),
    ];
    for (const attempt of attempts) {
      const error: unknown = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ code: "accept_terms_required", status: null });
    }
    expect(stub.calls).toBe(0);
  });

  it("names the current terms version when the server says the one passed is stale", async () => {
    stubFetch([
      {
        status: 409,
        body: {
          error: "policy_version_stale",
          code: 1043,
          details: { current_version: "2026-10-01" },
        },
      },
    ]);
    const error: unknown = await Hushscript.agent
      .signup({ ...SIGNUP, acceptTerms: "2020-01-01", baseUrl: BASE })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "policy_version_stale" });
    expect((error as ConflictError).hint).toContain("2026-10-01");
  });

  it("reaches the API through HUSHSCRIPT_BASE_URL when no baseUrl is passed", () => {
    const config = resolveTokenlessConfig({}, { env: { HUSHSCRIPT_BASE_URL: BASE } });
    expect(config.baseUrl).toBe(BASE);
    expect(() => config.authorization()).toThrow(ConfigurationError);
  });

  it("does not need a token, but still refuses a browser", () => {
    expect(() => resolveTokenlessConfig({}, { env: {} })).not.toThrow();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => resolveTokenlessConfig({}, { env: {} })).toThrow(ConfigurationError);
  });

  it("raises OutcomeUnknownError, without a hint, when the signup was sent and no answer came", async () => {
    const stub = stubFetch([{ error: networkError("ECONNRESET") }]);
    const error: unknown = await Hushscript.agent
      .signup({ ...SIGNUP, baseUrl: BASE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toBeNull();
    expect(stub.calls).toBe(1);
  });
});

describe("Hushscript.agent.claim", () => {
  it("claims once, without credentials, and returns the token and the balance", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          user_id: "usr_1",
          pat: CLAIMED_TOKEN,
          scopes: ["account:read", "billing"],
          balance_seconds: 2700,
        },
      },
    ]);
    const result = await Hushscript.agent.claim("hsr1:eu:abc", "cs_secret", { baseUrl: BASE });
    expect(result).toEqual({
      token: CLAIMED_TOKEN,
      userId: "usr_1",
      scopes: ["account:read", "billing"],
      balance: {
        seconds: 2700,
        minutes: 45,
        heldSeconds: 0,
        expiresAt: null,
        purchasesRemaining: null,
      },
    });
    const request = stub.requests[0];
    expect(request?.headers.get("authorization")).toBeNull();
    expect(decodeURIComponent(new URL(request?.url ?? "").pathname)).toBe(
      "/v1/agent/accounts/hsr1:eu:abc/claim",
    );
    expect(JSON.parse(stub.bodies[0] ?? "")).toEqual({ claim_secret: "cs_secret" });
    expect(redact(`leaked ${CLAIMED_TOKEN}`)).toBe(`leaked ${REDACTED}`);
  });

  it("never retries: a lost response is an unknown outcome with the claim hint", async () => {
    const stub = stubFetch([{ error: networkError("ECONNRESET") }]);
    const error: unknown = await Hushscript.agent
      .claim("sg_1", "cs_secret", { baseUrl: BASE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toContain("The claim may have succeeded.");
    expect(stub.calls).toBe(1);
  });

  it("never retries a 5xx either", async () => {
    const stub = stubFetch([{ status: 503, text: "unavailable" }]);
    await expect(
      Hushscript.agent.claim("sg_1", "cs_secret", { baseUrl: BASE }),
    ).rejects.toBeInstanceOf(Error);
    expect(stub.calls).toBe(1);
  });
});

describe("an unusable claim answer", () => {
  it.each([
    ["an empty body", { status: 200, text: "" }],
    ["a body that is not JSON", { status: 200, text: "<html>ok</html>" }],
    ["no token", { status: 200, body: { user_id: "usr_1", scopes: [], balance_seconds: 2700 } }],
    ["a token that is not a string", { status: 200, body: { pat: 7, user_id: "usr_1" } }],
    ["a token that is not one", { status: 200, body: { pat: "not a token\n", user_id: "usr_1" } }],
    ["a token with a space in it", { status: 200, body: { pat: "hsr1:eu:a b", user_id: "u" } }],
  ])(
    "is an unknown outcome with the claim hint, never a plain error, for %s",
    async (_n, answer) => {
      const stub = stubFetch([answer]);
      const error: unknown = await Hushscript.agent
        .claim("sg_1", "cs_secret", { baseUrl: BASE })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect((error as OutcomeUnknownError).hint).toContain("The claim may have succeeded.");
      const cause = (error as OutcomeUnknownError).cause;
      expect(cause).toMatchObject({ name: "ApiError", code: "bad_response" });
      expect(stub.calls).toBe(1);
    },
  );

  it("still returns the token when the rest of the answer is thin", async () => {
    stubFetch([{ status: 200, body: { pat: CLAIMED_TOKEN } }]);
    const claimed = await Hushscript.agent.claim("sg_1", "cs_secret", { baseUrl: BASE });
    expect(claimed).toMatchObject({ token: CLAIMED_TOKEN, userId: "", scopes: [] });
    expect(claimed.balance.seconds).toBe(0);
  });

  it("carries no job hint when the checkout is not paid yet", async () => {
    stubFetch([{ status: 409, body: { error: "wrong_state", code: 4001 } }]);
    const error: unknown = await Hushscript.agent
      .claim("sg_1", "cs_secret", { baseUrl: BASE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: "wrong_state", hint: null });
  });
});

describe("hs.agent.rotateToken", () => {
  it("swaps the client's token in place, so the next request uses the new one", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          pat: NEW_TOKEN,
          pat_id: "pat_2",
          scopes: ["account:read"],
          expires_at: 1_800_000_000,
        },
      },
      {
        status: 200,
        body: {
          balance_seconds: 60,
          held_seconds: 0,
          credits_expire_at: null,
          card_on_file: false,
          data_region: "eu",
          limits: LIMITS,
        },
      },
    ]);
    const hs = client();
    const rotated = await hs.agent.rotateToken();
    expect(rotated).toEqual({
      token: NEW_TOKEN,
      tokenId: "pat_2",
      scopes: ["account:read"],
      expiresAt: new Date(1_800_000_000_000),
    });
    await hs.balance();
    expect(stub.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(stub.requests[1]?.headers.get("authorization")).toBe(`Bearer ${NEW_TOKEN}`);
    expect(redact(`leaked ${NEW_TOKEN}`)).toBe(`leaked ${REDACTED}`);
    expect(String(hs)).not.toContain(NEW_TOKEN);
  });

  it("reports no expiry when the old token had none", async () => {
    stubFetch([{ status: 200, body: { pat: NEW_TOKEN, pat_id: "pat_3", scopes: [] } }]);
    expect((await client().agent.rotateToken()).expiresAt).toBeNull();
  });

  it("keeps the old token and raises OutcomeUnknownError when the answer is lost", async () => {
    const stub = stubFetch([
      { error: networkError("ECONNRESET") },
      {
        status: 200,
        body: {
          balance_seconds: 60,
          held_seconds: 0,
          credits_expire_at: null,
          card_on_file: false,
          data_region: "eu",
          limits: LIMITS,
        },
      },
    ]);
    const hs = client();
    const error: unknown = await hs.agent.rotateToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toContain("The old token may already be revoked.");
    await hs.balance();
    expect(stub.calls).toBe(2);
    expect(stub.requests[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps a rotated token that fails the format check on the error, out of every printout", async () => {
    const odd = "xyz-not-hsr-0123456789";
    stubFetch([{ status: 200, body: { pat: odd, pat_id: "pat_9", scopes: [] } }]);
    const error = (await client()
      .agent.rotateToken()
      .catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error.receivedToken).toBe(odd);
    expect(error.cause).toMatchObject({ code: "bad_response" });
    expect(Object.keys(error)).not.toContain("receivedToken");
    for (const printed of [inspect(error), String(error), error.message, JSON.stringify(error)]) {
      expect(printed).not.toContain(odd);
    }
  });

  it("registers the trimmed token for redaction when a claim pads it with whitespace", async () => {
    const padded = "hsr1:eu:padded-token-not-in-the-usual-shape-0123456789";
    stubFetch([{ status: 200, body: { pat: `  ${padded}\n`, user_id: "usr_1", scopes: [] } }]);
    const claimed = await Hushscript.agent.claim("sg_1", "cs_secret", { baseUrl: BASE });
    expect(claimed.token).toBe(padded);
    expect(redact(`leaked ${padded}`)).toBe(`leaked ${REDACTED}`);
  });

  it.each([
    ["claim", true],
    ["rotate", false],
  ])("registers a padded %s token that fails the format check", async (name, isClaim) => {
    const odd = `xyz-padded-${name}-token-0123456789`;
    stubFetch([{ status: 200, body: { pat: ` ${odd} `, pat_id: "pat_5" } }]);
    const attempt = isClaim
      ? Hushscript.agent.claim("sg_1", "cs_secret", { baseUrl: BASE })
      : client().agent.rotateToken();
    expect(await attempt.catch((e: unknown) => e)).toBeInstanceOf(OutcomeUnknownError);
    expect(redact(`leaked ${odd}`)).toBe(`leaked ${REDACTED}`);
  });

  it.each([
    ["a number out of the range of a date", 1e15],
    ["a string", "soon"],
  ])("keeps the old token for an expiry that is %s", async (_n, expires) => {
    const stub = stubFetch([
      { status: 200, body: { pat: NEW_TOKEN, pat_id: "pat_6", scopes: [], expires_at: expires } },
      { status: 200, body: ACCOUNT_BODY },
    ]);
    const hs = client();
    const error = (await hs.agent.rotateToken().catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error.cause).toMatchObject({ code: "bad_response" });
    expect(error.receivedToken).toBe(NEW_TOKEN);
    await hs.balance();
    expect(stub.requests[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each(["", "   "])("keeps no received token when the answer's token is %j", async (pat) => {
    stubFetch([{ status: 200, body: { pat, pat_id: "pat_7", scopes: [] } }]);
    const error = (await client()
      .agent.rotateToken()
      .catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error.receivedToken).toBeNull();
  });

  it("gives a claim no received token to keep", async () => {
    stubFetch([{ status: 200, body: { pat: "xyz-not-hsr-0123456789" } }]);
    const error = (await Hushscript.agent
      .claim("sg_1", "cs_secret", { baseUrl: BASE })
      .catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error.receivedToken).toBeNull();
  });

  it.each([
    ["an empty body", { status: 200, text: "" }],
    ["no token", { status: 200, body: { pat_id: "pat_9", scopes: [] } }],
    ["a token that is not one", { status: 200, body: { pat: "not a token", pat_id: "pat_9" } }],
  ])("is an unknown outcome and keeps the old token for %s", async (_n, answer) => {
    const stub = stubFetch([answer, { status: 200, body: ACCOUNT_BODY }]);
    const hs = client();
    const error: unknown = await hs.agent.rotateToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as OutcomeUnknownError).hint).toContain("The old token may already be revoked.");
    expect((error as OutcomeUnknownError).cause).toMatchObject({ code: "bad_response" });
    await hs.balance();
    expect(stub.requests[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("is used by a request that was waiting out a 503 when the rotation landed", async () => {
    const base = fakeClock();
    const box: { hs: Hushscript | undefined } = { hs: undefined };
    let rotating: Promise<unknown> | undefined;
    const clock: Clock = {
      now: () => base.now(),
      sleep: (ms, signal) => {
        if (ms === TEST_TIMEOUT_SECONDS * 1000) return base.sleep(ms, signal);
        rotating ??= box.hs?.agent.rotateToken() ?? Promise.resolve();
        return rotating.then(() => base.sleep(ms, signal));
      },
    };
    const stub = stubFetch([
      (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/agent/credentials/rotate") {
          return Response.json({ pat: NEW_TOKEN, pat_id: "pat_2", scopes: [] });
        }
        return stub.calls === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json(ACCOUNT_BODY);
      },
    ]);
    box.hs = new Hushscript({ token: TOKEN, baseUrl: BASE, clock, timeout: TEST_TIMEOUT_SECONDS });
    await box.hs.balance();
    expect(stub.requests.map((r) => r.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      `Bearer ${NEW_TOKEN}`,
    ]);
  });
});
