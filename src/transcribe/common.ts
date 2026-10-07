import type { Clock } from "../clock.ts";
import { AbortError, ApiError, HushscriptError } from "../errors.ts";

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
    message: `${route} answered with a body the SDK cannot use.`,
    status,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The body of a successful response; a 2xx with no body is a contract break, not something to guess around. */
export function present<T>(data: T | undefined, route: string): T {
  if (data === undefined) throw badResponse(route, null);
  return data;
}

/**
 * Awaits an API call and keeps anything that is not an SDK error (a 2xx whose body is not JSON
 * makes the fetch layer throw a SyntaxError) from escaping as a plain error.
 */
export async function guarded<T>(call: Promise<T>, route: string): Promise<T> {
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

/**
 * A 2xx body read as text and parsed here, so an empty or malformed one is an answer the caller
 * can judge (with the status in hand) instead of an exception from the fetch layer. The call must
 * be made with `parseAs: "text"`.
 */
export async function readObject(
  call: Promise<{ data?: unknown; response: Response }>,
  route: string,
): Promise<ObjectBody> {
  const { data, response } = await guarded(call, route);
  if (typeof data !== "string" || data === "") return { status: response.status, body: null };
  try {
    const parsed = JSON.parse(data) as unknown;
    const usable = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    return { status: response.status, body: usable ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { status: response.status, body: null };
  }
}
