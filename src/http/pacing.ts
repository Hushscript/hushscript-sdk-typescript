import type { Clock } from "../clock.ts";

/** At most `capacity` acquisitions in any `windowMs`; later callers wait for the window to slide. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #stamps: number[] = [];

  constructor(capacity: number, windowMs: number, clock: Clock) {
    this.#capacity = capacity;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  /** Resolves with the milliseconds spent waiting (0 when a slot was free). */
  async acquire(signal?: AbortSignal): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = this.#clock.now();
      // An empty list has no stamp to drop: now - Infinity is never past the window.
      while (now - (this.#stamps[0] ?? Infinity) >= this.#windowMs) {
        this.#stamps.shift();
      }
      const oldest = this.#stamps.length < this.#capacity ? undefined : this.#stamps[0];
      if (oldest === undefined) {
        this.#stamps.push(now);
        return waited;
      }
      const wait = oldest + this.#windowMs - now;
      await this.#clock.sleep(wait, signal);
      waited += wait;
    }
  }
}
