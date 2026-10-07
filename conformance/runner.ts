// Conformance runner (docs/runner-contract.md in the conformance repo). It starts nothing: the mock
// is the compose `mock` service this container shares a network namespace with.
//
// A scenario whose op (or `prior` op) has no mapping is reported as SKIP. The contract forbids
// skipping, so CONFORMANCE_STRICT=1 (the default in `just conformance`) turns every skip into a failure.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { Hushscript } from "../src/client.ts";
import type { Clock } from "../src/clock.ts";
import * as sdk from "../src/index.ts";
import { probeDuration } from "../src/transcribe/probe.ts";
import { openSource } from "../src/transcribe/source.ts";
import { goldens, renderGolden } from "./goldens.ts";

const BASE_URL = "http://127.0.0.1:4010";
const TEST_TOKEN = `hsr1:eu:pat.${"0123456789abcdef".repeat(2)}.${"fedcba9876543210".repeat(4)}`;
const SETTLE_MS = 20;
const STALL_MS = 500;
const SCENARIO_LIMIT_MS = 120_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;

interface ErrorExpectation {
  class?: string;
  code?: string;
  numericCode?: number;
  status?: number | null;
  details?: unknown;
  retryAfter?: number;
  hintContains?: string;
  fields?: Obj;
  messageExcludes?: string[];
}

interface CallSpec {
  op: string;
  args?: Obj;
  prior?: CallSpec;
  expectError?: ErrorExpectation;
}

interface Scenario {
  name: string;
  call: CallSpec;
  expect: { result?: unknown; error?: ErrorExpectation };
}

interface CallContext {
  /** The resume token of the `prior` call's error. */
  resumeToken: string | null;
}

interface MockState {
  pendingHolds: number;
  nextHoldAt: number | null;
}

const rawFetch = globalThis.fetch;

async function control(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(10_000) };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await rawFetch(`${BASE_URL}${path}`, init);
  if (!response.ok) throw new Error(`${method} ${path} answered ${String(response.status)}`);
  return await response.json();
}

async function mockState(): Promise<MockState> {
  return (await control("GET", "/__state")) as MockState;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The SDK's transport is the global fetch, so counting here counts the SDK's requests only: the
// runner's own control calls go through `rawFetch`.
const traffic = { inFlight: 0, activity: 0 };
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  traffic.inFlight += 1;
  traffic.activity += 1;
  return rawFetch(input, init).finally(() => {
    traffic.inFlight -= 1;
    traffic.activity += 1;
  });
};

interface Timer {
  at: number;
  wake: () => void;
}

/** Virtual time in ms. It only moves when the driver moves it, together with the mock's clock. */
class VirtualClock implements Clock {
  nowMs = 0;
  /** Bumped by every timer registered or cancelled; the driver reads it as SDK activity. */
  registrations = 0;
  readonly #timers = new Set<Timer>();

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    return new Promise<void>((resolve, reject) => {
      const timer: Timer = { at: this.nowMs + ms, wake: resolve };
      this.#timers.add(timer);
      this.registrations += 1;
      signal?.addEventListener(
        "abort",
        () => {
          if (this.#timers.delete(timer)) {
            this.registrations += 1;
            reject(signal.reason as Error);
          }
        },
        { once: true },
      );
    });
  }

  nextTimerAt(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers)
      if (earliest === null || timer.at < earliest) earliest = timer.at;
    return earliest;
  }

  fireDue(): void {
    const due = [...this.#timers]
      .filter((timer) => timer.at <= this.nowMs)
      .sort((a, b) => a.at - b.at);
    for (const timer of due) {
      this.#timers.delete(timer);
      timer.wake();
    }
    if (due.length > 0) this.registrations += 1;
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Runs `call` while stepping virtual time (contract section 5). Returns the call's outcome, or an
 * error string when the SDK stalled or the scenario ran out of real time.
 */
async function drive(call: Promise<unknown>, clock: VirtualClock): Promise<Outcome | string> {
  const done: { outcome?: Outcome } = {};
  const settled = (): boolean => done.outcome !== undefined;
  call.then(
    (value) => {
      done.outcome = { ok: true, value };
    },
    (error: unknown) => {
      done.outcome = { ok: false, error };
    },
  );
  const deadline = performance.now() + SCENARIO_LIMIT_MS;

  // True once the SDK has been quiet for `ms` of real time; false if the call settled first.
  const quiet = async (ms: number): Promise<boolean> => {
    let seen = -1;
    let since = performance.now();
    while (!settled()) {
      if (performance.now() > deadline) return false;
      await realSleep(2);
      const { pendingHolds } = await mockState();
      const activity = traffic.activity + clock.registrations;
      if (traffic.inFlight - pendingHolds > 0 || activity !== seen) {
        seen = activity;
        since = performance.now();
      } else if (performance.now() - since >= ms) {
        return true;
      }
    }
    return false;
  };

  while (!settled()) {
    if (!(await quiet(SETTLE_MS))) break;
    const mock = await mockState();
    const holdAt = mock.nextHoldAt === null ? null : Math.round(mock.nextHoldAt * 1000);
    const timerAt = clock.nextTimerAt();
    const target =
      timerAt === null ? holdAt : holdAt === null ? timerAt : Math.min(timerAt, holdAt);
    if (target === null) {
      // Nothing waits for time. Give any disk read or hashing the SDK is still doing the full
      // stall window before calling it a stall.
      if (!(await quiet(STALL_MS))) break;
      const again = await mockState();
      if (again.nextHoldAt === null && clock.nextTimerAt() === null && !settled()) {
        return "SDK stalled: the call is pending and nothing waits for time";
      }
      continue;
    }
    if (target > clock.nowMs) {
      await control("POST", "/__clock", { advance: (target - clock.nowMs) / 1000 });
      clock.nowMs = target;
    }
    // Held responses go out first; SDK timers due at the same instant fire after them.
    if (!(await quiet(SETTLE_MS))) break;
    clock.fireDue();
  }
  return done.outcome ?? "scenario ran out of real time";
}

let scratch: Promise<string> | undefined;
const downloaded = new Map<string, Promise<string>>();

/** A file under the mock's `fixtures/` (scenarios write `media/...`), saved once into a scratch directory. */
function fixtureFile(relative: string): Promise<string> {
  let found = downloaded.get(relative);
  if (found === undefined) {
    scratch ??= mkdtemp(join(tmpdir(), "hs-conformance-"));
    found = (async () => {
      const target = join(await scratch, "fixtures", relative);
      const response = await rawFetch(`${BASE_URL}/__files/fixtures/${relative}`);
      if (!response.ok)
        throw new Error(`fixture ${relative}: the mock answered ${String(response.status)}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(await response.arrayBuffer()));
      return target;
    })();
    downloaded.set(relative, found);
  }
  return found;
}

type Op = (hs: Hushscript, args: Obj, context: CallContext) => Promise<unknown>;

/** The contract's view of a transcript (runner-contract.md, `transcribe`). */
function transcriptResult(transcript: sdk.Transcript): Obj {
  return {
    id: transcript.id,
    title: transcript.title,
    language: transcript.language,
    durationSeconds: transcript.durationSeconds,
    utteranceCount: transcript.utterances.length,
    text: transcript.text,
    raw: transcript.toJSON(),
  };
}

function transcribeOptions(args: Obj): sdk.TranscribeOptions {
  return isObj(args["options"]) ? args["options"] : {};
}

const OPS: Record<string, Op> = {
  transcribe: async (hs, args) => {
    const file = await fixtureFile(String(args["file"]));
    return transcriptResult(await hs.transcribe(file, transcribeOptions(args)));
  },
  resume: async (hs, args, context) => {
    if (context.resumeToken === null)
      throw new Error("resume needs a prior call that raised a resume token");
    const file = typeof args["file"] === "string" ? await fixtureFile(args["file"]) : undefined;
    return transcriptResult(await hs.resume(context.resumeToken, file));
  },
  balance: async (hs) => {
    const balance = await hs.balance();
    return {
      seconds: balance.seconds,
      minutes: balance.minutes,
      heldSeconds: balance.heldSeconds,
      expiresAt: balance.expiresAt,
    };
  },
  listTranscripts: async (hs, args) => {
    const pageSize = typeof args["pageSize"] === "number" ? args["pageSize"] : undefined;
    const ids: string[] = [];
    for await (const row of hs.transcripts.list({ pageSize })) ids.push(row.id);
    return { count: ids.length, firstId: ids[0] ?? null, lastId: ids.at(-1) ?? null };
  },
  getTranscript: async (hs, args) => transcriptResult(await hs.transcripts.get(String(args["id"]))),
  buy: async (hs, args) => {
    const balance = await hs.buy(String(args["pack"]));
    return {
      seconds: balance.seconds,
      minutes: balance.minutes,
      heldSeconds: balance.heldSeconds,
      expiresAt: balance.expiresAt,
    };
  },
  claim: async (_hs, args) => {
    const claimed = await Hushscript.agent.claim(
      String(args["signupId"]),
      String(args["claimSecret"]),
      { baseUrl: BASE_URL },
    );
    return {
      token: claimed.token,
      userId: claimed.userId,
      scopes: claimed.scopes,
      seconds: claimed.balance.seconds,
    };
  },
  rotate: async (hs) => {
    const rotated = await hs.agent.rotateToken();
    return { token: rotated.token, tokenId: rotated.tokenId, scopes: rotated.scopes };
  },
};

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects match key by key, arrays element by element at equal length, scalars by equality. */
function subsetMismatches(expected: unknown, actual: unknown, path: string): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [`${path}: expected an array of ${String(expected.length)}`];
    }
    return expected.flatMap((item, index) =>
      subsetMismatches(item, actual[index], `${path}[${String(index)}]`),
    );
  }
  if (isObj(expected)) {
    if (!isObj(actual)) return [`${path}: expected an object`];
    return Object.entries(expected).flatMap(([key, value]) =>
      subsetMismatches(value, actual[key], `${path}.${key}`),
    );
  }
  return expected === actual
    ? []
    : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function errorClass(name: string): (new (...args: never[]) => Error) | undefined {
  const found = (sdk as unknown as Obj)[name];
  return typeof found === "function" ? (found as new (...args: never[]) => Error) : undefined;
}

function surfaces(error: unknown): string[] {
  const out = [inspect(error, { depth: 8 })];
  if (error instanceof Error) {
    out.push(error.message, error.stack ?? "", String(error));
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 6 && cause instanceof Error; depth += 1) {
      out.push(cause.message, cause.stack ?? "", String(cause));
      cause = cause.cause;
    }
  }
  if (error instanceof sdk.HushscriptError) {
    out.push(String(error.hint), JSON.stringify(error.details));
  }
  return out;
}

function errorMismatches(error: unknown, want: ErrorExpectation): string[] {
  const problems: string[] = [];
  if (want.class !== undefined) {
    const expected = errorClass(want.class);
    if (expected === undefined) problems.push(`unknown error class ${want.class}`);
    else if (!(error instanceof expected))
      problems.push(`expected ${want.class}, got ${inspect(error, { depth: 0 })}`);
  }
  if (!(error instanceof sdk.HushscriptError))
    return [...problems, `not an SDK error: ${inspect(error, { depth: 0 })}`];
  if (want.code !== undefined && error.code !== want.code)
    problems.push(`code ${error.code}, wanted ${want.code}`);
  if (want.numericCode !== undefined && error.numericCode !== want.numericCode) {
    problems.push(`numericCode ${String(error.numericCode)}, wanted ${String(want.numericCode)}`);
  }
  if (want.status !== undefined && error.status !== want.status) {
    problems.push(`status ${String(error.status)}, wanted ${String(want.status)}`);
  }
  if (want.retryAfter !== undefined && error.retryAfter !== want.retryAfter) {
    problems.push(`retryAfter ${String(error.retryAfter)}, wanted ${String(want.retryAfter)}`);
  }
  if (want.hintContains !== undefined && !(error.hint ?? "").includes(want.hintContains)) {
    problems.push(`hint ${JSON.stringify(error.hint)} lacks ${JSON.stringify(want.hintContains)}`);
  }
  if (want.details !== undefined)
    problems.push(...subsetMismatches(want.details, error.details, "details"));
  for (const [field, value] of Object.entries(want.fields ?? {})) {
    const actual = (error as unknown as Obj)[field];
    if (
      value === "<present>"
        ? actual === undefined || actual === null || actual === ""
        : actual !== value
    ) {
      problems.push(
        `field ${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const needle of (want.messageExcludes ?? []).map((n) => (n === "$TOKEN" ? TEST_TOKEN : n))) {
    if (surfaces(error).some((text) => text.includes(needle)))
      problems.push(`the error surfaces contain ${needle.slice(0, 16)}...`);
  }
  return problems;
}

function mapped(call: CallSpec): boolean {
  return (
    (call.op in OPS || call.op === "probe" || call.op === "format") &&
    (call.prior === undefined || mapped(call.prior))
  );
}

async function durations(): Promise<Record<string, number>> {
  return JSON.parse(await readFile(await fixtureFile("media/durations.json"), "utf8")) as Record<
    string,
    number
  >;
}

/** Probes every media fixture. It needs no virtual time, and its disk reads must not look like a stalled SDK. */
async function probeAll(args: Obj): Promise<unknown> {
  const tolerance = Number(args["toleranceSeconds"] ?? 1);
  const expected = await durations();
  const failures: Obj[] = [];
  for (const [name, seconds] of Object.entries(expected)) {
    const source = await openSource(await fixtureFile(`media/${name}`));
    try {
      const got = await probeDuration(source);
      if (Math.abs(got - seconds) > tolerance)
        failures.push({ file: name, expected: seconds, got });
    } catch (error) {
      failures.push({ file: name, expected: seconds, got: String(error) });
    } finally {
      await source.close();
    }
  }
  return { checked: Object.keys(expected).length, failures };
}

async function fetchText(path: string): Promise<string> {
  const response = await rawFetch(`${BASE_URL}/__files/${path}`);
  if (!response.ok) throw new Error(`${path}: the mock answered ${String(response.status)}`);
  return await response.text();
}

const transcriptBodies = new Map<string, Promise<string>>();

/** Renders every golden from its transcript fixture; it needs no virtual time and sends no API request. */
async function formatAll(): Promise<unknown> {
  const mismatches: string[] = [];
  const all = goldens();
  for (const golden of all) {
    let body = transcriptBodies.get(golden.transcript);
    if (body === undefined) {
      body = fetchText(`fixtures/transcripts/${golden.transcript}.json`);
      transcriptBodies.set(golden.transcript, body);
    }
    const rendered = renderGolden(
      golden,
      JSON.parse(await body) as Parameters<typeof renderGolden>[1],
    );
    if (rendered !== (await fetchText(`fixtures/exports/${golden.file}`)))
      mismatches.push(golden.file);
  }
  return { checked: all.length, mismatches };
}

async function runCall(
  hs: Hushscript,
  clock: VirtualClock,
  call: CallSpec,
  context: CallContext,
): Promise<Outcome | string> {
  if (call.op === "probe") {
    try {
      return { ok: true, value: await probeAll(call.args ?? {}) };
    } catch (error) {
      return { ok: false, error };
    }
  }
  if (call.op === "format") {
    try {
      return { ok: true, value: await formatAll() };
    } catch (error) {
      return { ok: false, error };
    }
  }
  const op = OPS[call.op];
  if (op === undefined) return `op ${call.op} is not mapped`;
  return drive(op(hs, call.args ?? {}, context), clock);
}

async function runScenario(scenario: Scenario): Promise<string[]> {
  await control("POST", "/__scenario", { name: scenario.name });
  const clock = new VirtualClock();
  const hs = new Hushscript({ token: TEST_TOKEN, baseUrl: BASE_URL, clock });
  const context: CallContext = { resumeToken: null };
  if (scenario.call.prior !== undefined) {
    const prior = scenario.call.prior;
    const outcome = await runCall(hs, clock, prior, context);
    if (typeof outcome === "string") return [`prior: ${outcome}`];
    if (outcome.ok) return ["prior call was expected to raise"];
    const problems = errorMismatches(outcome.error, prior.expectError ?? {});
    if (problems.length > 0) return problems.map((p) => `prior: ${p}`);
    const token = (outcome.error as { resumeToken?: unknown }).resumeToken;
    context.resumeToken = typeof token === "string" ? token : null;
  }
  await control("POST", "/__mark");
  const outcome = await runCall(hs, clock, scenario.call, context);
  if (typeof outcome === "string") return [outcome];
  const problems: string[] = [];
  if (scenario.expect.error !== undefined) {
    if (outcome.ok) problems.push("the call was expected to raise");
    else problems.push(...errorMismatches(outcome.error, scenario.expect.error));
  } else if (!outcome.ok) {
    problems.push(`the call raised: ${inspect(outcome.error, { depth: 2 })}`);
  } else if (scenario.expect.result !== undefined) {
    problems.push(
      ...subsetMismatches(
        scenario.expect.result,
        JSON.parse(JSON.stringify(outcome.value ?? null)) as Json,
        "result",
      ),
    );
  }
  const verify = (await control("GET", "/__verify")) as { failures: string[] };
  return [...problems, ...verify.failures];
}

async function main(): Promise<void> {
  const listing = (await control("GET", "/__scenarios")) as { scenarios?: unknown };
  const names = Array.isArray(listing.scenarios)
    ? listing.scenarios.filter((n): n is string => typeof n === "string")
    : [];
  if (names.length === 0) throw new Error("the mock lists no scenarios");
  // Downloads and disk reads are invisible to the driver's stall rule, so every fixture is fetched first.
  for (const name of Object.keys(await durations())) await fixtureFile(`media/${name}`);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const strict = process.env["CONFORMANCE_STRICT"] === "1";
  for (const name of names) {
    const scenario = (await control("GET", `/__files/scenarios/${name}.json`)) as Scenario;
    if (!mapped(scenario.call)) {
      if (strict) {
        failed += 1;
        console.log(`FAIL ${name}: op ${scenario.call.op} is not mapped (CONFORMANCE_STRICT=1)`);
      } else {
        skipped += 1;
        console.log(`SKIP ${name} (op ${scenario.call.op} is not mapped yet)`);
      }
      continue;
    }
    let problems: string[];
    try {
      problems = await runScenario(scenario);
    } catch (error) {
      problems = [`runner error: ${inspect(error, { depth: 3 })}`];
    }
    if (problems.length === 0) {
      passed += 1;
      console.log(`PASS ${name}`);
    } else {
      failed += 1;
      console.log(`FAIL ${name}: ${problems.join("; ")}`);
    }
  }
  console.log(`${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
