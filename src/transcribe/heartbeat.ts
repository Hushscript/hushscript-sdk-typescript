import type { Clock } from "../clock.ts";
import { AuthenticationError, HushscriptError } from "../errors.ts";

const HEARTBEAT_INTERVAL_MS = 120_000;

/**
 * Calls `send` every 120 s until the signal aborts (spec 8.5). Failures are ignored, except
 * `wrong_state` (the job moved on: stop quietly) and `unauthorized` (rethrown). Ticks are scheduled
 * from the start time, so a slow request does not stretch the interval.
 */
export async function runHeartbeat(options: {
  clock: Clock;
  signal: AbortSignal;
  send: () => Promise<unknown>;
  intervalMs?: number;
}): Promise<void> {
  const { clock, signal, send } = options;
  const interval = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let nextAt = clock.now() + interval;
  for (;;) {
    try {
      await clock.sleep(Math.max(0, nextAt - clock.now()), signal);
    } catch {
      return;
    }
    // Late by more than an interval (a suspended process): start again from now instead of bursting.
    nextAt = Math.max(nextAt, clock.now()) + interval;
    try {
      await send();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof HushscriptError && error.code === "wrong_state") return;
    }
  }
}
