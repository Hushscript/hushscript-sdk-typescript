import type { Client } from "openapi-fetch";
import { HushscriptError } from "../errors.ts";
import type { paths } from "../generated/schema";
import { badResponse } from "../transcribe/common.ts";

const VERBS = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;

/**
 * `hs.api` with one promise kept: it rejects with an SDK error. A 2xx whose body is not JSON makes
 * openapi-fetch throw a bare `SyntaxError`; that surfaces as `bad_response` instead (cause redacted).
 */
export function guardApi(raw: Client<paths>): Client<paths> {
  const guarded: Record<string, unknown> = {
    use: raw.use.bind(raw),
    eject: raw.eject.bind(raw),
  };
  const guard = (name: string, call: (...args: never[]) => Promise<unknown>) => {
    // `request(method, path, init)` carries the verb in front; the verb helpers do not.
    const routeAt = name === "request" ? 1 : 0;
    guarded[name] = async (...args: unknown[]) => {
      try {
        return await (call as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        if (error instanceof HushscriptError) throw error;
        const verb = name === "request" ? String(args[0]).toUpperCase() : name;
        throw badResponse(`${verb} ${String(args[routeAt])}`, null, error);
      }
    };
  };
  for (const verb of VERBS) guard(verb, raw[verb]);
  guard("request", raw.request);
  return guarded as unknown as Client<paths>;
}
