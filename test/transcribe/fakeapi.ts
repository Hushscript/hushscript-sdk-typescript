import { vi } from "vitest";
import type { ManualClock } from "../helpers";
import { BASE } from "../helpers";

type Route =
  | "account"
  | "create"
  | "partUrls"
  | "part"
  | "r2"
  | "heartbeat"
  | "complete"
  | "job"
  | "transcript";

interface Call {
  request: Request;
  /** Aborts when the request does; pass it to anything a hook waits on. */
  signal: AbortSignal;
  /** Part number for part, r2 and part-urls start. */
  n: number;
  /** Calls to this route before this one. */
  count: number;
  body: string;
  bytes: number;
}

export interface FakeConfig {
  balance?: number;
  maxDaily?: number;
  usedToday?: number;
  parts?: number;
  proxied?: boolean;
  completeState?: string;
  /** Replaces what the create response claims about the part plan. */
  plan?: { part_size_bytes?: number; total_parts?: number };
  /** Job reads: each phase answers `polls` reads (default 1); the last one is sticky. */
  jobFlow?: { state: string; polls?: number; error?: string; failure_kind?: string }[];
  /** Job reads for an id the create never minted answer 404 (default: they follow `jobFlow`). */
  strictJobs?: boolean;
  /** What an idempotent replay of the create reports as its job id (a job that was pruned and re-minted). */
  replayAs?: string;
  /** A hook that returns a Response replaces the default answer for that call. */
  hooks?: Partial<
    Record<Route, (call: Call, fake: Fake) => Response | undefined | Promise<Response | undefined>>
  >;
}

export interface Fake {
  calls: { route: Route; call: Call }[];
  creates: Record<string, unknown>[];
  completes: unknown[];
  r2Sizes: number[];
  r2Authorization: (string | null)[];
  directSuccesses: number;
  partNumbers: (route: "r2" | "part") => number[];
  routes: (route: Route) => Call[];
  count: (route: Route) => number;
  /** Distinct jobs the create has minted. */
  jobCount: () => number;
}

const PAGE = 16;

function jobView(
  id: string,
  state: string,
  current: { error?: string; failure_kind?: string } | null,
): Record<string, unknown> {
  return {
    id,
    state,
    mode: "standard",
    declared_seconds: 21,
    verified_seconds: 20,
    actual_seconds: null,
    billable_seconds: 0,
    error: current?.error ?? null,
    failure_kind: current?.failure_kind ?? null,
    retry_of: null,
    created_at: 1,
    transcript_id: state === "done" ? "tr_1" : null,
    private_result_expires_at: null,
    private_result_available: false,
    options: {},
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(
  slug: string,
  code: number,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: slug, code, ...extra }, status);
}

function classify(method: string, pathname: string): Route | null {
  if (method === "GET" && pathname === "/v1/account") return "account";
  if (method === "POST" && pathname === "/v1/uploads") return "create";
  if (method === "GET" && /^\/v1\/uploads\/[^/]+\/part-urls$/.test(pathname)) return "partUrls";
  if (method === "PUT" && /^\/v1\/uploads\/[^/]+\/parts\/\d+$/.test(pathname)) return "part";
  if (method === "PUT" && pathname.startsWith("/__r2/")) return "r2";
  if (method === "POST" && /^\/v1\/uploads\/[^/]+\/heartbeat$/.test(pathname)) return "heartbeat";
  if (method === "POST" && /^\/v1\/uploads\/[^/]+\/complete$/.test(pathname)) return "complete";
  if (method === "GET" && /^\/v1\/jobs\/[^/]+$/.test(pathname)) return "job";
  if (method === "GET" && /^\/v1\/transcripts\/[^/]+$/.test(pathname)) return "transcript";
  return null;
}

const TRANSCRIPT = {
  id: "tr_1",
  title: "T",
  language_detected: "en",
  duration_seconds: 20,
  speaker_names: {},
  tags: [],
  created_at: 1,
  updated_at: 1,
  auto_delete_at: null,
  edited: false,
  body: {
    version: 1,
    original: { utterances: [{ speaker: "A", start_ms: 0, end_ms: 1000, text: "hi" }] },
    translations: {},
  },
};

/** Installs a fake `/v1` API (and a fake storage) as the global fetch. Time is the caller's clock. */
export function fakeApi(config: FakeConfig = {}): Fake {
  const parts = config.parts ?? 3;
  const jobs = new Map<
    string,
    { size: number; partSize: number; total: number; completed: boolean }
  >();
  const keys = new Map<string, string>();
  const counts = new Map<Route, number>();
  let polls = 0;
  let phase = 0;
  const flow = config.jobFlow ?? [{ state: "processing", polls: 1 }, { state: "done" }];
  const fake: Fake = {
    calls: [],
    creates: [],
    completes: [],
    r2Sizes: [],
    r2Authorization: [],
    directSuccesses: 0,
    partNumbers: (route) => fake.routes(route).map((call) => call.n),
    routes: (route) =>
      fake.calls.filter((entry) => entry.route === route).map((entry) => entry.call),
    count: (route) => fake.routes(route).length,
    jobCount: () => jobs.size,
  };

  const page = (jobId: string, start: number): Record<string, unknown> | null => {
    const job = jobs.get(jobId);
    if (job === undefined) return null;
    const urls: { n: number; url: string }[] = [];
    for (let n = start; n < start + PAGE && n <= job.total; n += 1) {
      urls.push({
        n,
        url: `${BASE}/__r2/${jobId}/${String(n)}?sig=${String(fake.count("partUrls"))}`,
      });
    }
    return {
      part_size_bytes: config.plan?.part_size_bytes ?? job.partSize,
      total_parts: config.plan?.total_parts ?? job.total,
      part_urls: urls,
      next_part_number: start + PAGE <= job.total ? start + PAGE : null,
    };
  };

  const answer = (route: Route, call: Call): Response => {
    const pathname = new URL(call.request.url).pathname;
    const jobId = pathname.split("/")[3] ?? "job_1";
    switch (route) {
      case "account":
        return json({
          balance_seconds: config.balance ?? 36_000,
          held_seconds: 0,
          credits_expire_at: null,
          card_on_file: true,
          data_region: "eu",
          limits: {
            max_daily_seconds: config.maxDaily ?? 86_400,
            max_active_jobs: 50,
            active_jobs: 0,
            used_today_seconds: config.usedToday ?? 0,
          },
        });
      case "create": {
        const body = JSON.parse(call.body) as Record<string, unknown>;
        fake.creates.push(body);
        const key = typeof body["idempotency_key"] === "string" ? body["idempotency_key"] : null;
        let id = key === null ? undefined : keys.get(key);
        const replayed = id !== undefined;
        if (id === undefined) {
          id = `job_${String(jobs.size + 1)}`;
          const size = body["size_bytes"] as number;
          const partSize = Math.max(1, Math.ceil(size / parts));
          jobs.set(id, { size, partSize, total: Math.ceil(size / partSize), completed: false });
          if (key !== null) keys.set(key, id);
        }
        const direct = config.proxied !== true;
        const stateNow = jobs.get(id)?.completed === true ? "processing" : "uploading";
        return json({
          job_id: replayed && config.replayAs !== undefined ? config.replayAs : id,
          balance_seconds: 1,
          held_seconds: 1,
          limits: {
            max_daily_seconds: 1,
            max_active_jobs: 1,
            active_jobs: 0,
            used_today_seconds: 0,
          },
          upload: direct && stateNow === "uploading" ? page(id, 1) : null,
          funding: "personal",
          state: stateNow,
        });
      }
      case "partUrls":
        return json(config.proxied === true ? null : page(jobId, call.n));
      case "r2": {
        fake.r2Sizes.push(call.bytes);
        fake.r2Authorization.push(call.request.headers.get("authorization"));
        fake.directSuccesses += 1;
        return new Response("", { status: 200, headers: { etag: `"etag-${String(call.n)}"` } });
      }
      case "part":
        return json({ ok: true, part: call.n });
      case "heartbeat":
        return json({ ok: true });
      case "complete": {
        fake.completes.push(call.body === "" ? null : JSON.parse(call.body));
        const done = jobs.get(jobId);
        if (done !== undefined) done.completed = true;
        return json({
          ok: true,
          state: config.completeState ?? "queued",
          verified_seconds: 20,
          balance_seconds: 1,
          held_seconds: 0,
        });
      }
      case "job": {
        const known = jobs.get(jobId);
        if (known === undefined && config.strictJobs === true)
          return apiError("not_found", 1002, 404);
        if (known !== undefined && !known.completed) return json(jobView(jobId, "uploading", null));
        const current = flow[Math.min(phase, flow.length - 1)];
        if (current === undefined) throw new Error("empty job flow");
        polls += 1;
        const view = jobView(jobId, current.state, current);
        if (current.polls !== undefined && polls >= current.polls && phase < flow.length - 1) {
          phase += 1;
          polls = 0;
        }
        return json(view);
      }
      case "transcript":
        return json(TRANSCRIPT);
    }
  };

  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const route = classify(request.method, url.pathname);
      if (route === null) return json({ error: "not_found", code: 1 }, 404);
      const buffer = new Uint8Array(await request.arrayBuffer());
      const last = Number(url.pathname.split("/").at(-1));
      const start = url.searchParams.get("start");
      const call: Call = {
        request,
        signal: request.signal,
        n: route === "partUrls" ? Number(start ?? 1) : Number.isNaN(last) ? 0 : last,
        count: counts.get(route) ?? 0,
        body: route === "r2" || route === "part" ? "" : new TextDecoder().decode(buffer),
        bytes: buffer.byteLength,
      };
      counts.set(route, call.count + 1);
      fake.calls.push({ route, call });
      const hooked = await config.hooks?.[route]?.(call, fake);
      return hooked ?? answer(route, call);
    },
  );
  return fake;
}

/**
 * Runs `promise` while stepping a manual clock: when nothing else happens for a few macrotask
 * turns, the clock moves to the earliest pending timer (a smaller version of the conformance driver).
 */
export async function driven<T>(
  promise: Promise<T>,
  clock: ManualClock,
  limit = 20_000,
): Promise<T> {
  const state = { settled: false };
  const isSettled = (): boolean => state.settled;
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  for (let turns = 0; !isSettled(); turns += 1) {
    if (turns > limit) throw new Error("driven: the call did not settle");
    for (let i = 0; i < 4 && !isSettled(); i += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    if (isSettled()) break;
    const next = clock.pending.map((entry) => entry.at).sort((a, b) => a - b)[0];
    if (next !== undefined && next > clock.now()) clock.advance(next - clock.now());
    else if (next !== undefined) clock.advance(0);
  }
  return promise;
}
