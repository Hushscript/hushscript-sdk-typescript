import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../src/client";
import { AuthenticationError, HushscriptError } from "../src/errors";
import { BASE, TEST_TIMEOUT_SECONDS, TOKEN, fakeClock, stubFetch } from "./helpers";

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

  it.each([0, -1, 1.5, Number.NaN])("refuses pageSize %s before any request", async (pageSize) => {
    const f = stubFetch([{ status: 200, body: { transcripts: [], next_cursor: null } }]);
    expect(() => client().transcripts.list({ pageSize })).toThrow(
      expect.objectContaining({ code: "invalid_option" }) as Error,
    );
    await expect(client().transcripts.page({ pageSize })).rejects.toMatchObject({
      code: "invalid_option",
    });
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
    options: {},
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

  it("gets one job as camelCase fields", async () => {
    stubFetch([
      {
        status: 200,
        body: job("j9", "failed", {
          error: "bad",
          failure_kind: "media_unreadable",
          transcript_id: null,
          retry_of: "j8",
        }),
      },
    ]);
    expect(await client().jobs.get("j9")).toEqual({
      id: "j9",
      state: "failed",
      mode: "standard",
      declaredSeconds: 21,
      verifiedSeconds: 20,
      actualSeconds: null,
      billableSeconds: 0,
      error: "bad",
      failureKind: "media_unreadable",
      retryOf: "j8",
      createdAt: new Date(1_760_000_000_000),
      transcriptId: null,
    });
  });
});
