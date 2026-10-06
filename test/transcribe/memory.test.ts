/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hushscript } from "../../src/client";
import { openSource, type FileInput } from "../../src/transcribe/source";
import { uploadParts } from "../../src/transcribe/upload";
import { BASE, TOKEN, config, fakeClock } from "../helpers";

// Spec 8.4: memory stays within concurrency x part size. Each case parks every worker inside the
// transport, forces a collection, and counts the ArrayBuffer bytes still alive above the baseline.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

const MIB = 1024 * 1024;
const PART = 8 * MIB;
const PARTS = 8;

afterEach(() => {
  vi.unstubAllGlobals();
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function liveBytes(): Promise<number> {
  collect();
  await settle();
  collect();
  return process.memoryUsage().arrayBuffers;
}

/** Bytes alive, above the baseline, when `workers` parts are in the transport at once. */
async function measure(file: FileInput, workers: number): Promise<number> {
  const size = PART * PARTS;
  let inside = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let parked = 0;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    inside += 1;
    if (inside === workers) {
      parked = await liveBytes();
      release();
    }
    await barrier;
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    for (;;) if ((await reader.read()).done) break;
    return new Response(null, { status: 200, headers: { etag: '"e"' } });
  });
  const baseline = await liveBytes();
  const clock = fakeClock({ manual: true });
  const hs = new Hushscript({ token: TOKEN, baseUrl: BASE, clock });
  const source = await openSource(file, size);
  await uploadParts({
    cfg: config(clock),
    api: hs.api,
    jobId: "j1",
    source,
    plan: {
      part_size_bytes: PART,
      total_parts: PARTS,
      part_urls: Array.from({ length: PARTS }, (_, i) => ({
        n: i + 1,
        url: `http://r2.test/${String(i + 1)}`,
      })),
      next_part_number: null,
    },
    concurrency: workers,
    signal: new AbortController().signal,
    onAcked: () => undefined,
  });
  await source.close();
  return parked - baseline;
}

describe("memory bound (spec 8.4)", () => {
  it("holds one copy of each part in flight for a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hs-mem-"));
    const path = join(dir, "big.bin");
    const handle = await open(path, "w");
    await handle.write(new Uint8Array(PART * PARTS));
    await handle.close();
    try {
      const live = await measure(path, 4);
      expect(live).toBeGreaterThan(3 * PART);
      expect(live).toBeLessThanOrEqual(4 * PART * 1.25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("holds one part for a stream", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (sent >= PART * PARTS) controller.close();
          else {
            controller.enqueue(new Uint8Array(MIB));
            sent += MIB;
          }
        },
      },
      { highWaterMark: 0 },
    );
    const live = await measure(stream, 1);
    expect(live).toBeLessThanOrEqual(PART * 1.25);
  }, 60_000);

  it("adds nothing to a Uint8Array the caller already holds", async () => {
    const bytes = new Uint8Array(PART * PARTS);
    const live = await measure(bytes, 4);
    expect(bytes.byteLength).toBe(PART * PARTS);
    expect(live).toBeLessThanOrEqual(PART * 0.25);
  }, 60_000);
});
