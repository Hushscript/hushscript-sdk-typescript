export interface Page<T> {
  items: T[];
  /** Opaque; null on the last page. */
  nextCursor: string | null;
}

/** Walks a cursor-paged list one page at a time, yielding every item in order. */
export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
): AsyncIterable<T> {
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== null);
}
