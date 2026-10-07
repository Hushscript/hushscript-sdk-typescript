import type { ResolvedConfig } from "../config.ts";
import { hardenedFetch } from "./fetch.ts";
import { retryClassForRequest } from "./operations.ts";

/**
 * The `fetch` every friendly call and `hs.api` go through. The retry class comes from the request's
 * method and real URL, so a path a caller spelled out or a middleware that swapped the Request still
 * gets the right policy.
 */
export function createTransport(config: ResolvedConfig): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    // Only an upload create needs its body looked at: its retry class depends on the key.
    const body =
      request.method.toUpperCase() === "POST" && pathname === "/v1/uploads"
        ? await request.clone().text()
        : null;
    return hardenedFetch(config, retryClassForRequest(request.method, pathname, body))(request);
  };
}
