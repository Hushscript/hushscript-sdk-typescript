import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import {
  AbortError,
  UploadError,
  ValidationError,
} from "../../src/errors";
import { openSource, type Source } from "../../src/transcribe/source";
import { uploadParts, type PartAck, type UploadSettings } from "../../src/transcribe/upload";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, config, fakeClock, type ManualClock } from "../helpers";
import { apiError, driven, fakeApi, type Fake, type FakeConfig } from "./fakeapi";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PART = 4;
const HOUR = 3600 * 1000;

type Plan = NonNullable<UploadSettings["plan"]>;
type Hooks = NonNullable<FakeConfig["hooks"]>;

/** The part-urls page from `start` (16 URLs at most), signed with `sig` so a refetched URL differs from the old one. */
function page(start: number, total: number, sig: string): Pick<Plan, "part_urls" | "next_part_number"> {
  const urls: { n: number; url: string }[] = [];
  for (let n = start; n < start + 16 && n <= total; n += 1) {
    urls.push({ n, url: `${BASE}/__r2/job_1/${String(n)}?sig=${sig}` });
  }
  return { part_urls: urls, next_part_number: start + 16 <= total ? start + 16 : null };
}

/** A plan whose first page starts at `first`, signed "0". */
function planOf(total: number, first = 1): Plan {
  return { part_size_bytes: PART, total_parts: total, ...page(first, total, "0") };
}

/** Answers each part-urls request with the page it asks for, signed with the request's count. */
function pages(total: number): Hooks["partUrls"] {
  return (call) => Response.json(page(call.n, total, String(call.count + 1)));
}

function expired(): Response {
  return new Response("<Error>Request has expired</Error>", { status: 403 });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The signature of every URL part `n` was PUT to, in order. */
function sigs(fake: Fake, n: number): (string | null)[] {
  return fake
    .routes("r2")
    .filter((call) => call.n === n)
    .map((call) => new URL(call.request.url).searchParams.get("sig"));
}

/** A stream-like source: read once, in order, calling `beforeRead` with the part number first. */
function steppedSource(total: number, beforeRead: (n: number) => void): Source {
  const size = total * PART;
  return {
    size,
    probeInput: null,
    sequential: true,
    head: () => Promise.resolve(new Uint8Array(0)),
    read: (offset, length) => {
      beforeRead(offset / PART + 1);
      return Promise.resolve(new Uint8Array(Math.min(length, size - offset)));
    },
    close: () => Promise.resolve(),
  };
}

interface Send {
  total: number;
  plan?: Plan | null;
  concurrency?: number;
  source?: Source;
  signal?: AbortSignal;
  onAcked?: (bytesSent: number) => void;
}

function harness(
  hooks: Hooks = {},
  options: { clock?: ManualClock; maxRetries?: number } = {},
): { clock: ManualClock; fake: Fake; send: (run: Send) => Promise<PartAck[] | null> } {
  const clock = options.clock ?? fakeClock({ manual: true });
  const maxRetries = options.maxRetries ?? 0;
  const fake = fakeApi({ hooks });
  const hs = new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock,
    timeout: TEST_TIMEOUT_SECONDS,
    maxRetries,
  });
  const cfg = config(clock, { maxRetries });
  const send = async (run: Send): Promise<PartAck[] | null> => {
    const source = run.source ?? (await openSource(new Uint8Array(run.total * PART)));
    return driven(
      uploadParts({
        cfg,
        api: hs.api,
        jobId: "job_1",
        source,
        plan: run.plan === undefined ? planOf(run.total) : run.plan,
        concurrency: run.concurrency ?? 4,
        signal: run.signal ?? new AbortController().signal,
        onAcked: run.onAcked ?? (() => undefined),
      }),
      clock,
    );
  };
  return { clock, fake, send };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e: unknown) => e);
}

describe("uploadParts results", () => {
  it("returns the ETags sorted by part number when storage answers in reverse order", async () => {
    const clock = fakeClock({ manual: true });
    const { send } = harness(
      {
        r2: async (call) => {
          await clock.sleep((4 - call.n) * 1000);
          return undefined;
        },
      },
      { clock },
    );
    expect(await send({ total: 3 })).toEqual([
      { n: 1, etag: "etag-1" },
      { n: 2, etag: "etag-2" },
      { n: 3, etag: "etag-3" },
    ]);
  });

  it("returns null for a job with no plan, whose parts all went through the API", async () => {
    const { fake, send } = harness();
    expect(await send({ total: 3, plan: null })).toBeNull();
    expect(fake.partNumbers("part")).toEqual([1]);
  });

  it.each([0, 1.5, -1])("refuses a part size of %s before any request", async (size) => {
    const { fake, send } = harness();
    const error = await failure(send({ total: 3, plan: { ...planOf(3), part_size_bytes: size } }));
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "bad_part_plan",
      message: "The API returned an unusable part size.",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a plan whose part count does not match the file, naming both counts", async () => {
    const { fake, send } = harness();
    const error = await failure(send({ total: 3, plan: { ...planOf(3), total_parts: 99 } }));
    expect(error).toMatchObject({
      name: "UploadError",
      code: "bad_part_plan",
      message: "The API planned 99 parts; the file needs 3.",
    });
    expect(fake.calls).toEqual([]);
  });

  it("raises AbortError when the caller aborts between two parts, sending no more", async () => {
    const { fake, send } = harness();
    const caller = new AbortController();
    const error = await failure(
      send({
        total: 3,
        concurrency: 1,
        signal: caller.signal,
        onAcked: () => {
          caller.abort();
        },
      }),
    );
    expect(error).toBeInstanceOf(AbortError);
    expect(fake.partNumbers("r2")).toEqual([1]);
  });
});

describe("part URL pages", () => {
  it("fetches a page again only once its URLs are more than 23 h old", async () => {
    const clock = fakeClock({ manual: true });
    const { fake, send } = harness({ partUrls: pages(4) }, { clock });
    const source = steppedSource(4, (n) => {
      if (n === 2) clock.advance(23 * HOUR);
      if (n === 3) clock.advance(1);
    });
    await send({ total: 4, source });
    expect(fake.partNumbers("partUrls")).toEqual([1]);
    expect([1, 2, 3, 4].map((n) => sigs(fake, n))).toEqual([["0"], ["0"], ["1"], ["1"]]);
  });

  it("goes proxied for every part when a part-urls page has no URLs", async () => {
    const { fake, send } = harness({
      partUrls: () => Response.json({ part_urls: [], next_part_number: null }),
    });
    const plan: Plan = { ...planOf(3), part_urls: [], next_part_number: 1 };
    expect(await send({ total: 3, plan })).toBeNull();
    expect(fake.partNumbers("partUrls")).toEqual([1]);
    expect(fake.partNumbers("part").sort()).toEqual([1, 2, 3]);
    expect(fake.count("r2")).toBe(0);
  });

  it("raises part_url_missing for a part no page covers, without asking for a page or going proxied", async () => {
    const { fake, send } = harness();
    const error = await failure(send({ total: 17, plan: planOf(17, 2), concurrency: 1 }));
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "part_url_missing",
      message: "No upload URL for part 1.",
    });
    expect(fake.count("partUrls")).toBe(0);
    expect(fake.count("r2")).toBe(0);
    expect(fake.count("part")).toBe(0);
  });

  it("refetches an earlier page in place and keeps the pointer to the next one", async () => {
    let releasePartTwo: () => void = () => undefined;
    const partSeventeenSent = new Promise<void>((resolve) => {
      releasePartTwo = resolve;
    });
    let pageOneServed: () => void = () => undefined;
    const pageOneBack = new Promise<void>((resolve) => {
      pageOneServed = resolve;
    });
    const { fake, send } = harness({
      partUrls: (call) => {
        if (call.n === 1) pageOneServed();
        return Response.json(page(call.n, 40, String(call.count + 1)));
      },
      r2: async (call, f) => {
        if (call.n === 17) releasePartTwo();
        if (call.n === 2 && f.routes("r2").filter((c) => c.n === 2).length === 1) {
          // Part 2 fails with an expired URL only after page 17 is loaded.
          await partSeventeenSent;
          return expired();
        }
        if (call.n === 18) {
          await pageOneBack;
          await settle();
        }
        return undefined;
      },
    });
    const acks = await send({ total: 40, concurrency: 2 });
    expect(acks?.map((ack) => ack.n)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(fake.partNumbers("partUrls")).toEqual([17, 1, 33]);
    expect(sigs(fake, 2)).toEqual(["0", "2"]);
  });

  it("asks for the same page again when a second part finds a refreshed URL expired too", async () => {
    const { fake, send } = harness({
      partUrls: pages(3),
      r2: (call, f) =>
        call.n < 3 && f.routes("r2").filter((c) => c.n === call.n).length === 1
          ? expired()
          : undefined,
    });
    await send({ total: 3, concurrency: 1 });
    expect(fake.partNumbers("partUrls")).toEqual([1, 1]);
    expect(sigs(fake, 1)).toEqual(["0", "1"]);
    expect(sigs(fake, 2)).toEqual(["1", "2"]);
    expect(sigs(fake, 3)).toEqual(["2"]);
  });

  it("does not ask again for a page another part has already refreshed", async () => {
    let pageServed: () => void = () => undefined;
    const served = new Promise<void>((resolve) => {
      pageServed = resolve;
    });
    const { fake, send } = harness({
      partUrls: (call) => {
        pageServed();
        return Response.json(page(call.n, 3, String(call.count + 1)));
      },
      r2: async (call, f) => {
        if (f.routes("r2").filter((c) => c.n === call.n).length > 1) return undefined;
        if (call.n === 1) return expired();
        if (call.n === 2) {
          // Part 2 took its URL before part 1's refresh and fails only after it.
          await served;
          for (let i = 0; i < 3; i += 1) await settle();
          return expired();
        }
        return undefined;
      },
    });
    await send({ total: 3, concurrency: 2 });
    expect(fake.count("partUrls")).toBe(1);
    expect(sigs(fake, 1)).toEqual(["0", "1"]);
    expect(sigs(fake, 2)).toEqual(["0", "1"]);
  });
});

describe("failed direct parts", () => {
  it("surfaces a part's own failure, without falling back, when the caller aborts as it lands", async () => {
    const caller = new AbortController();
    const { fake, send } = harness({
      r2: () => {
        caller.abort();
        return new Response(null, { status: 204 });
      },
    });
    const error = await failure(send({ total: 3, concurrency: 1, signal: caller.signal }));
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "etag_missing",
      message: "Storage answered a part without an ETag.",
    });
    expect(fake.count("part")).toBe(0);
    expect(fake.count("partUrls")).toBe(0);
  });

  it("raises AbortError, not parts_exhausted, when the caller aborts during a refresh", async () => {
    const caller = new AbortController();
    const { fake, send } = harness({
      r2: (call) => (call.n === 3 ? expired() : undefined),
      partUrls: () => {
        caller.abort();
        return undefined;
      },
    });
    const error = await failure(send({ total: 8, concurrency: 1, signal: caller.signal }));
    expect(error).toBeInstanceOf(AbortError);
    expect(fake.count("partUrls")).toBe(1);
  });

  it("raises parts_exhausted with the refresh's error as the cause once direct PUTs worked", async () => {
    const { fake, send } = harness({
      r2: (call) => (call.n === 3 ? expired() : undefined),
      partUrls: () => apiError("unavailable", 9001, 503),
    });
    const error = await failure(send({ total: 8, concurrency: 1 }));
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "parts_exhausted",
      message: "Part 3 failed after retries and a fresh URL.",
    });
    expect((error as UploadError).cause).toMatchObject({ name: "ApiError", code: "unavailable" });
    expect(fake.count("part")).toBe(0);
  });

  it("falls back to proxied parts when the refresh is refused 401 before any direct PUT worked", async () => {
    const { fake, send } = harness({
      r2: () => expired(),
      partUrls: () => apiError("unauthorized", 2000, 401),
    });
    expect(await send({ total: 3 })).toBeNull();
    expect(fake.partNumbers("part").sort()).toEqual([1, 2, 3]);
  });

  it("rethrows a 400 from the next page once direct PUTs worked", async () => {
    const { fake, send } = harness({ partUrls: () => apiError("bad_request", 1000, 400) });
    const error = await failure(send({ total: 20, concurrency: 1 }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400 });
    expect(fake.count("r2")).toBe(16);
  });

  it("raises parts_exhausted, caused by the 429, when the next page stays rate limited", async () => {
    const { send } = harness({ partUrls: () => apiError("too_fast", 1001, 429) });
    const error = await failure(send({ total: 20, concurrency: 1 }));
    expect(error).toMatchObject({ name: "UploadError", code: "parts_exhausted" });
    expect((error as UploadError).cause).toMatchObject({ name: "RateLimitError", code: "too_fast" });
  });

  it("keeps a part whose direct PUT lands after the switch to proxied out of the direct path", async () => {
    let proxiedOne: () => void = () => undefined;
    const partOneProxied = new Promise<void>((resolve) => {
      proxiedOne = resolve;
    });
    let proxiedTwo: () => void = () => undefined;
    const partTwoProxied = new Promise<void>((resolve) => {
      proxiedTwo = resolve;
    });
    const { fake, send } = harness({
      r2: async (call) => {
        if (call.n === 1) return apiError("internal_error", 9000, 500);
        await (call.n === 2 ? partOneProxied : partTwoProxied);
        return call.n === 2 ? undefined : apiError("internal_error", 9000, 500);
      },
      part: (call) => {
        if (call.n === 1) proxiedOne();
        if (call.n === 2) proxiedTwo();
        return undefined;
      },
    });
    expect(await send({ total: 3, concurrency: 3 })).toBeNull();
    expect(fake.partNumbers("part")).toEqual([1, 2, 3]);
    // A direct success that landed late must not count: part 3 falls back without a refresh.
    expect(fake.count("partUrls")).toBe(0);
  });

  it("stops the other parts in flight once one part fails", async () => {
    const clock = fakeClock({ manual: true });
    let allIn: () => void = () => undefined;
    const fourInFlight = new Promise<void>((resolve) => {
      allIn = resolve;
    });
    const { fake, send } = harness(
      {
        part: async (call, f) => {
          if (f.count("part") === 4) allIn();
          if (call.n === 2) {
            await fourInFlight;
            return apiError("bad_request", 1000, 400);
          }
          await clock.sleep(1000, call.signal).catch(() => undefined);
          return undefined;
        },
      },
      { clock },
    );
    const plan: Plan = { ...planOf(40), part_urls: null, next_part_number: null };
    const error = await failure(send({ total: 40, plan, concurrency: 4 }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(fake.partNumbers("part").sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(
      fake
        .routes("part")
        .filter((call) => call.n !== 2)
        .every((call) => call.signal.aborted),
    ).toBe(true);
  });
});
