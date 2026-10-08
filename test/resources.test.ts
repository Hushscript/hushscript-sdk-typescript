import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { AbortError, AuthenticationError, HushscriptError, PreflightError } from "../src/errors";
import { BASE, JOB_OPTIONS, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): Hushscript {
  return new Hushscript({
    token: TOKEN,
    baseUrl: BASE,
    clock: fakeClock(),
    timeout: TEST_TIMEOUT_SECONDS,
  });
}

function row(n: number): Record<string, unknown> {
  return {
    id: `tr_${String(n)}`,
    title: `T${String(n)}`,
    language_detected: n % 2 === 0 ? "en" : null,
    duration_seconds: 30 + n,
    created_at: 1_760_000_000 + n,
    auto_delete_at: n === 1 ? 1_760_100_000 : null,
    tags: ["a"],
    options: {},
    insights_state: "none",
  };
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("hs.transcripts", () => {
  it("lists summaries across pages, sending a cursor only after the first page and no limit unless asked", async () => {
    const f = stubFetch([
      { status: 200, body: { transcripts: [row(1), row(2)], next_cursor: "c1" } },
      { status: 200, body: { transcripts: [row(3)], next_cursor: null } },
    ]);
    const all = await drain(client().transcripts.list());
    expect(all.map((t) => t.id)).toEqual(["tr_1", "tr_2", "tr_3"]);
    expect(all[0]).toEqual({
      id: "tr_1",
      title: "T1",
      language: null,
      durationSeconds: 31,
      createdAt: new Date(1_760_000_001_000),
      autoDeleteAt: new Date(1_760_100_000_000),
      tags: ["a"],
    });
    expect(all[1]?.language).toBe("en");
    expect(f.requests.map((r) => new URL(r.url).search)).toEqual(["", "?cursor=c1"]);
  });

  it("sends pageSize as limit on every page", async () => {
    const f = stubFetch([
      { status: 200, body: { transcripts: [row(1)], next_cursor: "c1" } },
      { status: 200, body: { transcripts: [], next_cursor: null } },
    ]);
    await drain(client().transcripts.list({ pageSize: 100 }));
    expect(f.requests.map((r) => new URL(r.url).search)).toEqual([
      "?limit=100",
      "?limit=100&cursor=c1",
    ]);
  });

  it("returns one page with its cursor", async () => {
    const f = stubFetch([{ status: 200, body: { transcripts: [row(1)], next_cursor: "next" } }]);
    const page = await client().transcripts.page({ cursor: "c0", pageSize: 5 });
    expect(page.nextCursor).toBe("next");
    expect(page.items).toHaveLength(1);
    expect(new URL(f.requests[0]?.url ?? "").searchParams.get("cursor")).toBe("c0");
  });

  it("raises pagination_loop from a single page whose next_cursor is the cursor sent", async () => {
    const f = stubFetch([{ status: 200, body: { transcripts: [row(1)], next_cursor: "c0" } }]);
    const error = await client()
      .transcripts.page({ cursor: "c0" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HushscriptError);
    expect(error).toMatchObject({ code: "pagination_loop", status: null });
    expect((error as HushscriptError).message).toBe(
      "The API returned the same page cursor it was sent; stopping instead of repeating the page.",
    );
    expect(f.calls).toBe(1);
  });

  it.each([
    ["no cursor sent, a cursor answered", undefined, "c0", "c0"],
    ["a cursor sent, a different one answered", "c0", "c1", "c1"],
    ["a cursor sent, the last page answered", "c0", null, null],
    ["a cursor sent, an empty cursor answered (the last page)", "c0", "", null],
    ["an empty cursor sent, an empty cursor answered", "", "", null],
    ["a cursor sent, the same letters in another case answered", "c0", "C0", "C0"],
  ])("does not call it a loop: %s", async (_label, sent, answered, expected) => {
    stubFetch([{ status: 200, body: { transcripts: [row(1)], next_cursor: answered } }]);
    const page = await client().transcripts.page(sent === undefined ? {} : { cursor: sent });
    expect(page.nextCursor).toBe(expected);
    expect(page.items).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses pageSize %s before any request", async (pageSize) => {
    const f = stubFetch([{ status: 200, body: { transcripts: [], next_cursor: null } }]);
    let listError: unknown;
    try {
      client().transcripts.list({ pageSize });
    } catch (error) {
      listError = error;
    }
    expect(listError).toBeInstanceOf(PreflightError);
    expect(listError).toMatchObject({ code: "invalid_option", status: null });
    const pageError: unknown = await client()
      .transcripts.page({ pageSize })
      .catch((error: unknown) => error);
    expect(pageError).toBeInstanceOf(PreflightError);
    expect(pageError).toMatchObject({ code: "invalid_option", status: null });
    expect(f.calls).toBe(0);
  });

  it("gets a transcript as the Transcript model", async () => {
    const f = stubFetch([
      {
        status: 200,
        body: {
          id: "tr_9",
          title: "Nine",
          language_detected: "en",
          duration_seconds: 5,
          speaker_names: {},
          tags: [],
          created_at: 1,
          updated_at: 2,
          auto_delete_at: null,
          edited: false,
          matter_code: null,
          client_code: null,
          body: {
            version: 1,
            original: { utterances: [{ speaker: "", start_ms: 0, end_ms: 10, text: "hey" }] },
            translations: {},
          },
        },
      },
    ]);
    const t = await client().transcripts.get("tr_9");
    expect(t.text).toBe("hey");
    expect(f.requests[0]?.url).toBe(`${BASE}/v1/transcripts/tr_9`);
  });

  it("lists deletion records across pages", async () => {
    const record = {
      id: "tr_d",
      title: "Gone",
      duration_seconds: 12,
      created_at: 100,
      deleted_at: 200,
      cause: "manual",
      receipt: null,
    };
    const f = stubFetch([
      { status: 200, body: { deleted: [record], next_cursor: "d1" } },
      {
        status: 200,
        body: { deleted: [{ ...record, id: "tr_e", cause: "expired" }], next_cursor: null },
      },
    ]);
    const all = await drain(client().transcripts.deleted());
    expect(all).toEqual([
      {
        id: "tr_d",
        title: "Gone",
        durationSeconds: 12,
        createdAt: new Date(100_000),
        deletedAt: new Date(200_000),
        cause: "manual",
        receipt: null,
      },
      expect.objectContaining({ id: "tr_e", cause: "expired" }) as unknown,
    ]);
    expect(f.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual([
      "/v1/transcripts/deleted",
      "/v1/transcripts/deleted?cursor=d1",
    ]);
  });

  it("keeps a deletion receipt opaque, with its snake_case keys and string timestamps, and lets an unknown cause through", async () => {
    const receipt = {
      type: "deletion",
      version: 1,
      created_at: "2026-09-07T14:53:35Z",
      items: [{ kind: "transcript", deleted_at: "2026-09-07T14:53:35Z" }],
    };
    stubFetch([
      {
        status: 200,
        body: {
          deleted: [
            {
              id: "tr_r",
              title: "R",
              duration_seconds: 1,
              created_at: 1,
              deleted_at: 2,
              cause: "legal_hold_release",
              receipt,
            },
          ],
          next_cursor: null,
        },
      },
    ]);
    const [record] = await drain(client().transcripts.deleted());
    expect(record?.receipt).toEqual(receipt);
    expect(record?.cause).toBe("legal_hold_release");
  });

  it("raises the SDK's typed error for a refused call", async () => {
    stubFetch([{ status: 401, body: { error: "unauthorized", code: 2000 } }]);
    const error = await drain(client().transcripts.list()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toBeInstanceOf(HushscriptError);
  });
});

function job(
  id: string,
  state: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    state,
    mode: "standard",
    declared_seconds: 21,
    verified_seconds: 20,
    actual_seconds: null,
    billable_seconds: 0,
    error: null,
    failure_kind: null,
    retry_of: null,
    created_at: 1_760_000_000,
    transcript_id: null,
    private_result_expires_at: null,
    private_result_available: false,
    options: JOB_OPTIONS,
    ...extra,
  };
}

describe("hs.jobs", () => {
  it("lists jobs, asking only for active ones when told to, and lets an unknown state through", async () => {
    const f = stubFetch([
      { status: 200, body: { jobs: [job("j1", "processing")], next_cursor: "j-next" } },
      { status: 200, body: { jobs: [job("j2", "reviewing")], next_cursor: null } },
    ]);
    const all = await drain(client().jobs.list({ active: true }));
    expect(all.map((j) => [j.id, j.state])).toEqual([
      ["j1", "processing"],
      ["j2", "reviewing"],
    ]);
    expect(f.requests.map((r) => new URL(r.url).search)).toEqual([
      "?active=true",
      "?active=true&cursor=j-next",
    ]);
  });

  it("asks for every job when active is not set", async () => {
    const f = stubFetch([{ status: 200, body: { jobs: [], next_cursor: null } }]);
    await drain(client().jobs.list());
    expect(new URL(f.requests[0]?.url ?? "").search).toBe("");
  });

  it("gets one job as the spec 6.4 shape: camelCase fields and options, without private-result or fetch fields", async () => {
    stubFetch([
      {
        status: 200,
        body: job("j9", "failed", {
          error: "bad",
          failure_kind: "media_unreadable",
          transcript_id: null,
          retry_of: "j8",
          private_result_expires_at: 1_760_000_500,
          private_result_available: true,
          fetched_bytes: 10,
          fetch_total_bytes: 20,
          options: {
            language_code: "de",
            speaker_detection: true,
            medical_mode: false,
            multichannel: false,
            translation_targets: ["es", "fr"],
            keyterms: true,
            prompt: false,
            auto_generate_insights: null,
          },
        }),
      },
    ]);
    expect(await client().jobs.get("j9")).toEqual({
      id: "j9",
      state: "failed",
      transcriptId: null,
      error: "bad",
      failureKind: "media_unreadable",
      mode: "standard",
      declaredSeconds: 21,
      verifiedSeconds: 20,
      actualSeconds: null,
      billableSeconds: 0,
      retryOf: "j8",
      createdAt: new Date(1_760_000_000_000),
      options: {
        languageCode: "de",
        speakerDetection: true,
        medicalMode: false,
        multichannel: false,
        translationTargets: ["es", "fr"],
        keyterms: true,
        prompt: false,
        autoGenerateInsights: null,
      },
    });
  });
});

describe("unknown nested fields (R90)", () => {
  it("keeps unknown job option fields, camelCased", async () => {
    stubFetch([
      {
        status: 200,
        body: job("j1", "done", {
          options: { ...JOB_OPTIONS, redact_pii: true, vocab: { boost_level: 2 } },
        }),
      },
    ]);
    const options = (await client().jobs.get("j1")).options as unknown as Record<string, unknown>;
    expect(options["redactPii"]).toBe(true);
    expect(options["vocab"]).toEqual({ boostLevel: 2 });
    expect(options["languageCode"]).toBe(JOB_OPTIONS.language_code);
  });
});

describe("signal on lists", () => {
  it("stops transcripts.list between pages and sends no further request", async () => {
    const f = stubFetch([
      { status: 200, body: { transcripts: [row(1), row(2)], next_cursor: "c1" } },
      { status: 200, body: { transcripts: [row(3)], next_cursor: null } },
    ]);
    const stop = new AbortController();
    const seen: string[] = [];
    const error = await (async () => {
      for await (const item of client().transcripts.list({ signal: stop.signal })) {
        seen.push(item.id);
        if (seen.length === 2) stop.abort();
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbortError);
    expect(seen).toEqual(["tr_1", "tr_2"]);
    expect(f.calls).toBe(1);
  });

  it("passes the signal to the page request itself", async () => {
    const stop = new AbortController();
    const f = stubFetch([{ status: 200, body: { transcripts: [], next_cursor: null } }]);
    await client().transcripts.page({ signal: stop.signal });
    expect(f.requests).toHaveLength(1);
    stop.abort();
    await expect(client().transcripts.page({ signal: stop.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(f.calls).toBe(1);
  });

  it("stops deleted() and jobs.list() between pages", async () => {
    const record = {
      id: "d",
      title: "t",
      duration_seconds: 1,
      created_at: 1,
      deleted_at: 2,
      cause: "manual",
      receipt: null,
    };
    const stop = new AbortController();
    const f = stubFetch([{ status: 200, body: { deleted: [record], next_cursor: "d1" } }]);
    const deleted = client().transcripts.deleted({ signal: stop.signal })[Symbol.asyncIterator]();
    await deleted.next();
    stop.abort();
    await expect(deleted.next()).rejects.toBeInstanceOf(AbortError);
    expect(f.calls).toBe(1);

    const stopJobs = new AbortController();
    const g = stubFetch([{ status: 200, body: { jobs: [job("j1", "done")], next_cursor: "j1" } }]);
    const jobs = client().jobs.list({ signal: stopJobs.signal })[Symbol.asyncIterator]();
    await jobs.next();
    stopJobs.abort();
    await expect(jobs.next()).rejects.toBeInstanceOf(AbortError);
    expect(g.calls).toBe(1);
  });

  it("raises pagination_loop through a real list when the API repeats a cursor", async () => {
    stubFetch([
      { status: 200, body: { transcripts: [row(1)], next_cursor: "c1" } },
      { status: 200, body: { transcripts: [row(2)], next_cursor: "c1" } },
    ]);
    await expect(drain(client().transcripts.list())).rejects.toMatchObject({
      code: "pagination_loop",
    });
  });
});

describe("resource path identifiers (R52/R53)", () => {
  it.each(["", ".", "..", null, 42, {}])("refuses invalid id %j before any request", async (id) => {
    const f = stubFetch([]);
    const hs = client();
    const invalid = id as unknown as string;
    for (const run of [
      () => hs.jobs.get(invalid),
      () => hs.jobs.wait(invalid),
      () => hs.transcripts.get(invalid),
    ]) {
      const error: unknown = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreflightError);
      expect(error).toMatchObject({ code: "invalid_option", status: null });
      expect(f.calls).toBe(0);
    }
  });
});
