import type { Clock } from "../clock.ts";
import { AbortError } from "../errors.ts";

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

/** The body of a successful response; a 2xx with no body is a contract break, not something to guess around. */
export function present<T>(data: T | undefined, route: string): T {
  if (data === undefined) throw new Error(`${route} returned no body`);
  return data;
}
