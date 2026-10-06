import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AbortError, HushscriptError } from "../src/errors";
import { paginate, type Page } from "../src/paginate";

function rows(total: number, size: number): (cursor: string | null) => Promise<Page<number>> {
  return (cursor) => {
    const from = cursor === null ? 0 : Number(cursor);
    const to = Math.min(from + size, total);
    return Promise.resolve({
      items: Array.from({ length: to - from }, (_, i) => from + i),
      nextCursor: to < total ? String(to) : null,
    });
  };
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("paginate", () => {
  it("follows two cursors across 120 rows at 50 a page", async () => {
    const cursors: (string | null)[] = [];
    const fetchPage = rows(120, 50);
    const seen = await drain(
      paginate((cursor) => {
        cursors.push(cursor);
        return fetchPage(cursor);
      }),
    );
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(cursors).toEqual([null, "50", "100"]);
  });

  it("makes one request for an empty list and none before iteration starts", async () => {
    let calls = 0;
    const iterable = paginate(() => {
      calls += 1;
      return Promise.resolve({ items: [], nextCursor: null });
    });
    expect(calls).toBe(0);
    expect(await drain(iterable)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("fetches the next page only when the consumer asks for it", async () => {
    let calls = 0;
    const fetchPage = rows(10, 5);
    const iterator = paginate((cursor) => {
      calls += 1;
      return fetchPage(cursor);
    })[Symbol.asyncIterator]();
    await iterator.next();
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i += 1) await iterator.next();
    expect(calls).toBe(2);
  });

  it("yields everything, in order, whatever the page size", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(300), fc.integer({ min: 1, max: 100 }), async (total, size) => {
        expect(await drain(paginate(rows(total, size)))).toEqual(
          Array.from({ length: total }, (_, i) => i),
        );
      }),
    );
  });

  it("passes a fetch failure on to the consumer after the rows it already got", async () => {
    const seen: number[] = [];
    const fetchPage = rows(10, 5);
    const failing = paginate((cursor) =>
      cursor === null ? fetchPage(cursor) : Promise.reject(new Error("boom")),
    );
    await expect(
      (async () => {
        for await (const item of failing) seen.push(item);
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("raises pagination_loop when a page hands back the cursor it was sent", async () => {
    const sent: (string | null)[] = [];
    const seen: number[] = [];
    const looping = paginate((cursor) => {
      sent.push(cursor);
      return Promise.resolve({ items: [sent.length], nextCursor: "same" });
    });
    const error = await (async () => {
      for await (const item of looping) seen.push(item);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({ code: "pagination_loop" });
    // The first page's "same" is new; the second page repeats it, so the walk ends after two requests.
    expect(sent).toEqual([null, "same"]);
    expect(seen).toEqual([1, 2]);
  });

  it("continues past an empty page that carries a new cursor", async () => {
    const seen = await drain(
      paginate((cursor) =>
        Promise.resolve(
          cursor === null ? { items: [], nextCursor: "c1" } : { items: [7], nextCursor: null },
        ),
      ),
    );
    expect(seen).toEqual([7]);
  });

  it("stops between pages and between items once the signal aborts", async () => {
    const stop = new AbortController();
    const fetchPage = rows(10, 5);
    let calls = 0;
    const walk = paginate((cursor) => {
      calls += 1;
      return fetchPage(cursor);
    }, stop.signal);
    const seen: number[] = [];
    const error = await (async () => {
      for await (const item of walk) {
        seen.push(item);
        if (item === 1) stop.abort();
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbortError);
    expect(seen).toEqual([0, 1]);
    expect(calls).toBe(1);
  });

  it("does not fetch at all when the signal is already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    let calls = 0;
    const walk = paginate(() => {
      calls += 1;
      return Promise.resolve({ items: [1], nextCursor: null });
    }, stop.signal);
    await expect(drain(walk)).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(0);
  });
});
