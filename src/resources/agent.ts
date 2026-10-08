import createClient, { type Client } from "openapi-fetch";
import { unknownFields } from "../camel.ts";
import { checkToken, resolveTokenlessConfig, type ResolvedConfig } from "../config.ts";
import { OutcomeUnknownError, ValidationError } from "../errors.ts";
import type { components, paths } from "../generated/schema";
import { createTransport } from "../http/transport.ts";
import { toMoney, type Money } from "../money.ts";
import { registerSecret, withRedactedField } from "../redact.ts";
import { describeProblem, timestamp } from "../shape.ts";
import { AGENT_SIGNUP } from "../shapes.ts";
import { badResponse, readBody, readObject } from "../transcribe/common.ts";
import { checkPathId } from "../transcribe/preflight.ts";
import type { Balance } from "./account.ts";

export interface AgentSignupRequest {
  /** For receipts and notices only; it never signs in. */
  email: string;
  /** New agent accounts can buy only these two until earlier purchases settle. */
  pack: "45min" | "300min";
  /** The policy version being accepted. Never defaulted: a stale one is refused with the current version in the hint. */
  acceptTerms: string;
  agent: { name: string; platform: string; contactUrl?: string | undefined };
  dataRegion?: string | undefined;
  /** Validates the request without opening a checkout; the result cannot be claimed. */
  dryRun?: boolean | undefined;
  /** Falls back to HUSHSCRIPT_BASE_URL, then the production host. */
  baseUrl?: string | null | undefined;
}

/**
 * The signup answer. A field the API adds later is kept on the object at run time, camelCased.
 */
export interface AgentSignup {
  /** Pass it back to `claim` verbatim. */
  signupId: string;
  /** Shown once; `claim` needs it. */
  claimSecret: string;
  /** Where the account is paid for: a hosted checkout page that expires at `expiresAt`. */
  checkoutUrl: string;
  price: Money;
  expiresAt: Date;
}

/**
 * The claim answer. A field the API adds later is kept on the object at run time, camelCased.
 */
export interface AgentClaim {
  /** The account's token, shown once. */
  token: string;
  userId: string;
  scopes: string[];
  /** The pack just granted; a new account holds nothing, and the expiry is not part of the answer. */
  balance: Balance;
}

/**
 * The rotation answer. A field the API adds later is kept on the object at run time, camelCased.
 */
export interface RotatedToken {
  /** The successor token, shown once; the client already uses it. */
  token: string;
  tokenId: string;
  scopes: string[];
  expiresAt: Date | null;
}

/** `Hushscript.agent`: the two calls that need no token. */
export interface AgentStatic {
  signup(request: AgentSignupRequest): Promise<AgentSignup>;
  claim(
    signupId: string,
    claimSecret: string,
    options?: { baseUrl?: string | null | undefined },
  ): Promise<AgentClaim>;
}

const CLAIM_ROUTE = "POST /v1/agent/accounts/{signup_id}/claim";
const ROTATE_ROUTE = "POST /v1/agent/credentials/rotate";

/** The answer was a 2xx but carried no token: the credential was minted and is lost, like a lost response. */
function lostCredential(
  route: string,
  status: number,
  received?: string,
  cause?: unknown,
): OutcomeUnknownError {
  return new OutcomeUnknownError({
    message: `${route} answered ${String(status)} without a usable token, so the token may be lost.`,
    hint: OutcomeUnknownError.hintFor(route),
    cause: badResponse(route, status, cause),
    ...(received === undefined ? {} : { receivedToken: received }),
  });
}

/** The token a claim or rotate answer carries, checked like any token; anything else is a lost credential. */
function tokenOf(
  body: Record<string, unknown> | null,
  route: string,
  status: number,
  keepReceived: boolean,
): string {
  const pat = body?.["pat"];
  if (typeof pat !== "string") throw lostCredential(route, status);
  // Remembered so it is redacted from whatever is printed, even when it is not a valid token.
  registerSecret(pat.trim());
  try {
    return checkToken(pat);
  } catch (error) {
    const received = keepReceived && pat.trim() !== "" ? pat : undefined;
    throw lostCredential(route, status, received, error);
  }
}

const SIGNUP_FIELDS: ReadonlySet<string> = new Set([
  ...([
    "signup_id",
    "claim_secret",
    "checkout_url",
    "pack",
    "amount",
    "currency",
    "expires_at",
  ] satisfies (keyof components["schemas"]["AgentSignupResponse"])[]),
]);
const CLAIM_FIELDS: ReadonlySet<string> = new Set(["pat", "balance_seconds", "user_id", "scopes"]);
const ROTATE_FIELDS: ReadonlySet<string> = new Set(["pat", "pat_id", "scopes", "expires_at"]);

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function tokenlessApi(baseUrl: string | null | undefined): Client<paths> {
  const config = resolveTokenlessConfig({ baseUrl });
  const api = createClient<paths>({ baseUrl: config.baseUrl, fetch: createTransport(config) });
  api.use({
    onRequest: ({ request }) => {
      request.headers.set("user-agent", config.userAgent);
    },
  });
  return api;
}

export const agentStatic: AgentStatic = {
  async signup(request) {
    // Typed as required, but a JavaScript caller can leave it out.
    const terms: unknown = request.acceptTerms;
    if (typeof terms !== "string" || terms === "") {
      throw new ValidationError({
        code: "accept_terms_required",
        message:
          "acceptTerms is required: pass the policy version you accept. It is never filled in for you.",
      });
    }
    const api = tokenlessApi(request.baseUrl);
    const body = await readBody<components["schemas"]["AgentSignupResponse"]>(
      api.POST("/v1/agent/accounts", {
        body: {
          contact_email: request.email,
          pack_id: request.pack,
          accept_terms_version: request.acceptTerms,
          agent: {
            name: request.agent.name,
            platform: request.agent.platform,
            ...(request.agent.contactUrl === undefined
              ? {}
              : { contact_url: request.agent.contactUrl }),
          },
          ...(request.dataRegion === undefined ? {} : { data_region: request.dataRegion }),
          ...(request.dryRun === undefined ? {} : { dry_run: request.dryRun }),
        },
        parseAs: "text",
      }),
      "POST /v1/agent/accounts",
      AGENT_SIGNUP,
    );
    return withRedactedField(
      "AgentSignup",
      {
        ...unknownFields(body, SIGNUP_FIELDS),
        signupId: body.signup_id,
        claimSecret: body.claim_secret,
        checkoutUrl: body.checkout_url,
        price: toMoney(body.amount, body.currency),
        expiresAt: new Date(body.expires_at * 1000),
      },
      "claimSecret",
    );
  },

  async claim(signupId, claimSecret, options = {}) {
    checkPathId(signupId, "signupId");
    // Remembered like a token, so no error message, hint or cause raised by this call can print it.
    if (typeof claimSecret === "string") registerSecret(claimSecret);
    const api = tokenlessApi(options.baseUrl);
    const { status, body } = await readObject(
      api.POST("/v1/agent/accounts/{signup_id}/claim", {
        // The OpenAPI document leaves the {signup_id} path parameter out of this operation, so its
        // generated type has no `path`; openapi-fetch still fills the template from it.
        params: { path: { signup_id: signupId } } as never,
        body: { claim_secret: claimSecret },
        parseAs: "text",
      }),
      CLAIM_ROUTE,
    );
    const pat = tokenOf(body, CLAIM_ROUTE, status, false);
    const seconds = body?.["balance_seconds"];
    const balanceSeconds = typeof seconds === "number" && Number.isInteger(seconds) ? seconds : 0;
    const userId = body?.["user_id"];
    return withRedactedField(
      "AgentClaim",
      {
        ...(body === null ? {} : unknownFields(body, CLAIM_FIELDS)),
        token: pat,
        userId: typeof userId === "string" ? userId : "",
        scopes: strings(body?.["scopes"]),
        // A fresh account has no holds; the claim answer carries no expiry, and a follow-up read
        // could fail after the token was shown for the only time.
        balance: {
          seconds: balanceSeconds,
          minutes: Math.trunc(balanceSeconds / 60),
          heldSeconds: 0,
          expiresAt: null,
          purchasesRemaining: null,
        },
      },
      "token",
    );
  },
};

/** `hs.agent`: calls an agent account makes with its own token. */
export class AgentResource {
  readonly #api: Client<paths>;
  readonly #config: ResolvedConfig;

  constructor(api: Client<paths>, config: ResolvedConfig) {
    this.#api = api;
    this.#config = config;
  }

  /**
   * Mints a successor token and revokes the one in use. The client starts using the new token at
   * once; store the returned one. A lost answer raises `OutcomeUnknownError` and is never retried.
   */
  async rotateToken(): Promise<RotatedToken> {
    const { status, body } = await readObject(
      this.#api.POST("/v1/agent/credentials/rotate", { parseAs: "text" }),
      ROTATE_ROUTE,
    );
    const pat = tokenOf(body, ROTATE_ROUTE, status, true);
    const expiresAt = body?.["expires_at"];
    // Checked before the client swaps tokens: an unusable answer keeps the old one, like any other.
    if (expiresAt !== undefined && expiresAt !== null) {
      const found = timestamp(expiresAt);
      if (found !== null) {
        const problem = describeProblem({ path: ["expires_at"], expected: found.expected });
        throw lostCredential(ROTATE_ROUTE, status, pat, new Error(problem));
      }
    }
    this.#config.setToken(pat);
    const tokenId = body?.["pat_id"];
    return withRedactedField(
      "RotatedToken",
      {
        ...(body === null ? {} : unknownFields(body, ROTATE_FIELDS)),
        token: pat,
        tokenId: typeof tokenId === "string" ? tokenId : "",
        scopes: strings(body?.["scopes"]),
        expiresAt: typeof expiresAt === "number" ? new Date(expiresAt * 1000) : null,
      },
      "token",
    );
  }
}
