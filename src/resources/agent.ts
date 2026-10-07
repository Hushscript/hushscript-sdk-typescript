import createClient, { type Client } from "openapi-fetch";
import { resolveTokenlessConfig, type ResolvedConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { paths } from "../generated/schema";
import { createTransport } from "../http/transport.ts";
import { toMoney, type Money } from "../money.ts";
import { registerSecret } from "../redact.ts";
import { present } from "../transcribe/common.ts";
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
  baseUrl?: string | undefined;
}

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

export interface AgentClaim {
  /** The account's token, shown once. */
  token: string;
  userId: string;
  scopes: string[];
  /** The pack just granted; a new account holds nothing, and the expiry is not part of the answer. */
  balance: Balance;
}

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
    options?: { baseUrl?: string | undefined },
  ): Promise<AgentClaim>;
}

function tokenlessApi(baseUrl: string | undefined): Client<paths> {
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
    const { data } = await api.POST("/v1/agent/accounts", {
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
    });
    const body = present(data, "POST /v1/agent/accounts");
    return {
      signupId: body.signup_id,
      claimSecret: body.claim_secret,
      checkoutUrl: body.checkout_url,
      price: toMoney(body.amount, body.currency),
      expiresAt: new Date(body.expires_at * 1000),
    };
  },

  async claim(signupId, claimSecret, options = {}) {
    const api = tokenlessApi(options.baseUrl);
    const { data } = await api.POST("/v1/agent/accounts/{signup_id}/claim", {
      // The OpenAPI document leaves the {signup_id} path parameter out of this operation, so its
      // generated type has no `path`; openapi-fetch still fills the template from it.
      params: { path: { signup_id: signupId } } as never,
      body: { claim_secret: claimSecret },
    });
    const body = present(data, "POST /v1/agent/accounts/{signup_id}/claim");
    registerSecret(body.pat);
    return {
      token: body.pat,
      userId: body.user_id,
      scopes: body.scopes,
      // A fresh account has no holds; the claim answer carries no expiry, and a follow-up read
      // could fail after the token was shown for the only time.
      balance: {
        seconds: body.balance_seconds,
        minutes: Math.trunc(body.balance_seconds / 60),
        heldSeconds: 0,
        expiresAt: null,
        purchasesRemaining: null,
      },
    };
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
    const { data } = await this.#api.POST("/v1/agent/credentials/rotate");
    const body = present(data, "POST /v1/agent/credentials/rotate");
    this.#config.setToken(body.pat);
    return {
      token: body.pat,
      tokenId: body.pat_id,
      scopes: body.scopes,
      expiresAt: typeof body.expires_at === "number" ? new Date(body.expires_at * 1000) : null,
    };
  }
}
