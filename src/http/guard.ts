import type { Client } from "openapi-fetch";
import { HushscriptError } from "../errors.ts";
import type { paths } from "../generated/schema";
import { badResponse } from "../transcribe/common.ts";

const METHODS = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;

/**
 * `hs.api` with one promise kept: it rejects with an SDK error. A 2xx whose body is not JSON makes
 * openapi-fetch throw a bare `SyntaxError`; that surfaces as `bad_response` instead (cause redacted).
 */
export function guardApi(raw: Client<paths>): Client<paths> {
  const guarded: Record<string, unknown> = {
    use: raw.use.bind(raw),
    eject: raw.eject.bind(raw),
  };
  for (const method of METHODS) {
    guarded[method] = async (path: string, init?: unknown) => {
      try {
        return await (raw[method] as (path: string, init?: unknown) => Promise<unknown>)(
          path,
          init,
        );
      } catch (error) {
        if (error instanceof HushscriptError) throw error;
        throw badResponse(`${method} ${path}`, null, error);
      }
    };
  }
  return guarded as unknown as Client<paths>;
}
