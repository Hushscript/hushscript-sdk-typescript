import type { Clock } from "../clock.ts";
import { MAX_BODY_DEPTH, nestsDeeperThan } from "../depth.ts";
import { AbortError, ApiError, HushscriptError, describeError } from "../errors.ts";
import { describeProblem, type Shape } from "../shape.ts";

export function aborted(signal: AbortSignal): AbortError {
  return new AbortError({ message: "The request was aborted.", cause: signal.reason });
}

/** `clock.sleep` that rejects with the SDK's `AbortError` when the signal fires. */
export async function sleepOrAbort(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await clock.sleep(ms, signal);
  } catch (error) {
    if (signal.aborted) throw aborted(signal);
    throw error;
  }
}

/** A 2xx whose body cannot be used. `status` is the 2xx when known. */
export function badResponse(route: string, status: number | null, cause?: unknown): ApiError {
  return new ApiError({
    code: "bad_response",
    message: `${route} answered with a body the SDK cannot use${cause === undefined ? "" : ` (${describeError(cause)})`}.`,
    status,
    cause,
  });
}

/** What a call made with `parseAs: "text"` resolves to. */
type TextCall = Promise<{ data?: unknown; response: Response }>;

/**
 * Awaits an API call and keeps anything that is not an SDK error (the fetch layer throwing on a
 * body it could not read) from escaping as a plain error.
 */
async function guarded<T>(call: Promise<T>, route: string): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof HushscriptError) throw error;
    throw badResponse(route, null, error);
  }
}

/** What `readObject` hands back: the 2xx status and the body, or null when the body is not a JSON object. */
export interface ObjectBody {
  status: number;
  body: Record<string, unknown> | null;
}

/** A body nested deeper than any real one is treated as unusable, so no walk over it can overflow the stack. */
function usable(json: unknown): unknown {
  return nestsDeeperThan(json, MAX_BODY_DEPTH) ? undefined : json;
}

/** The 2xx status and the parsed body; `json` is undefined when the body is empty or not JSON. */
async function readJson(call: TextCall, route: string): Promise<{ status: number; json: unknown }> {
  const { data, response } = await guarded(call, route);
  try {
    // `data` is the body text, or undefined for an empty 2xx; "" and "undefined" do not parse either.
    return { status: response.status, json: usable(JSON.parse(String(data))) };
  } catch {
    return { status: response.status, json: undefined };
  }
}

/**
 * The one boundary every body the friendly layer maps goes through. The call must be made with
 * `parseAs: "text"`, so the real 2xx status is at hand when the body is empty, is not JSON or does
 * not fit `shape`: all of them raise `bad_response` with that status, never a plain error.
 */
export async function readBody<T>(call: TextCall, route: string, shape: Shape): Promise<T> {
  const { status, json } = await readJson(call, route);
  const found = json === undefined ? { path: [], expected: "a JSON body" } : shape(json);
  if (found !== null) throw badResponse(route, status, new Error(describeProblem(found)));
  return json as T;
}

/**
 * A 2xx body as a plain object or null, for calls whose caller must judge an unusable body itself
 * (a lost credential, a purchase) with the status in hand.
 */
export async function readObject(call: TextCall, route: string): Promise<ObjectBody> {
  const { status, json } = await readJson(call, route);
  const isObject = typeof json === "object" && !Array.isArray(json);
  return { status, body: isObject ? (json as Record<string, unknown> | null) : null };
}
