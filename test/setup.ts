import fc from "fast-check";
import { stall } from "./helpers";

// Nightly CI multiplies every property's iteration count (FC_RUNS_FACTOR=10).
const factor = Number(process.env["FC_RUNS_FACTOR"] ?? "1");
fc.configureGlobal({ numRuns: 100 * (Number.isFinite(factor) && factor > 0 ? factor : 1) });

/**
 * Far more reads than any test takes from one stream. A read loop that keeps going on an ended
 * stream spins on microtasks no test timeout interrupts; past the cap every read stalls instead
 * (see `stall`), so the test times out and fails.
 */
const READ_CAP = 1000;
const reads = new WeakMap<object, number>();
type Read = ReadableStreamDefaultReader["read"];
const original = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "read")
  ?.value as Read;
ReadableStreamDefaultReader.prototype.read = function capped(
  this: ReadableStreamDefaultReader,
): ReturnType<Read> {
  const count = (reads.get(this) ?? 0) + 1;
  reads.set(this, count);
  if (count > READ_CAP) return stall(`a stream read more than ${String(READ_CAP)} times`);
  return original.call(this);
} as Read;
