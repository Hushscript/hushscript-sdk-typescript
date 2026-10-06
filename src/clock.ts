/** Time as the SDK sees it. Injected so conformance runs and tests never wait in real time. */
export interface Clock {
  /** Milliseconds on a monotonic-enough scale; only differences matter. */
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: (): number => Date.now(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
