import { HushscriptError } from "./errors.ts";
import { aborted } from "./transcribe/common.ts";

export interface Page<T> {
  items: T[];
  /** Opaque; null on the last page. */
  nextCursor: string | null;
}

/** A page's `next_cursor` as the SDK hands it on: null and the empty string both mean the last page. */
export function nextCursorOf(cursor: string | null): string | null {
  return cursor === "" ? null : cursor;
}

/** A page that hands back the cursor it was asked with would repeat forever. */
export function assertCursorAdvanced(sent: string | null, next: string | null): void {
  if (next !== null && next === sent) {
    throw new HushscriptError({
      code: "pagination_loop",
      message:
        "The API returned the same page cursor it was sent; stopping instead of repeating the page.",
    });
  }
}

// A function call, so the compiler does not carry an earlier `signal.aborted` check into the loop.
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw aborted(signal);
}

/**
 * Walks a cursor-paged list one page at a time, yielding every item in order. `signal` is checked
 * before every page and every item, so an abort between pages or mid-page stops the walk with the
 * SDK's `AbortError`; the page request itself is the caller's to cancel with the same signal. A page
 * that hands back the cursor it was asked with would repeat forever, so it raises `pagination_loop`.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  let cursor: string | null = null;
  do {
    stopIfAborted(signal);
    const sent: string | null = cursor;
    const page: Page<T> = await fetchPage(sent);
    for (const item of page.items) {
      stopIfAborted(signal);
      yield item;
    }
    cursor = nextCursorOf(page.nextCursor);
    assertCursorAdvanced(sent, cursor);
  } while (cursor !== null);
}
