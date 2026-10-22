import type * as FsPromises from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbortError, PreflightError, UploadError } from "../../src/errors";
import { openSource } from "../../src/transcribe/source";

/** Set by a test to replace `open` from node:fs/promises; everything else stays real. */
const fsHooks = vi.hoisted(() => ({
  open: undefined as ((path: string) => Promise<unknown>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      fsHooks.open === undefined ? actual.open(...args) : fsHooks.open(String(args[0])),
  };
});

afterEach(() => {
  fsHooks.open = undefined;
});

const DATA = Uint8Array.from({ length: 100 }, (_, i) => i);
const UNSUPPORTED = "file must be a path, a Blob, a Uint8Array or a ReadableStream.";
const NEEDS_SIZE =
  "A stream input needs size (and durationSeconds); the SDK will not buffer an unbounded stream.";

async function file(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "hs-src-")), "data.bin");
  await writeFile(path, DATA);
  return path;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("random-access sources", () => {
  it.each([
    ["a path", async () => openSource(await file())],
    ["a Uint8Array", async () => openSource(DATA)],
    ["a Blob", async () => openSource(new Blob([DATA]))],
  ])("reads byte ranges from %s", async (_name, make) => {
    const source = await make();
    expect(source.size).toBe(100);
    expect(source.sequential).toBe(false);
    expect([...(await source.read(10, 5))]).toEqual([10, 11, 12, 13, 14]);
    expect([...(await source.read(98, 10))]).toEqual([98, 99]);
    expect((await source.read(100, 4)).byteLength).toBe(0);
    expect([...(await source.head(3))]).toEqual([0, 1, 2]);
    await source.close();
  });

  it.each([
    ["a path", async () => openSource(await file())],
    ["bytes", async () => openSource(DATA)],
    ["a Blob", async () => openSource(new Blob([DATA]))],
  ])("honors a pre-aborted signal for %s ranges and headers", async (_name, make) => {
    const source = await make();
    const stop = new AbortController();
    stop.abort();
    try {
      await expect(source.read(0, 10, stop.signal)).rejects.toBeInstanceOf(AbortError);
      await expect(source.head(10, stop.signal)).rejects.toBeInstanceOf(AbortError);
      expect(await source.read(0, 10)).toEqual(DATA.subarray(0, 10));
    } finally {
      await source.close();
    }
  });

  it("refuses a directory", async () => {
    await expect(openSource(tmpdir())).rejects.toBeInstanceOf(PreflightError);
  });

  it.each([
    ["a number", 42],
    ["a plain object", {}],
    ["a plain object with a size", { size: 5 }],
  ])("refuses %s: it is not a path, bytes, a Blob or a stream", async (_name, input) => {
    for (const size of [undefined, 5]) {
      await expect(openSource(input as unknown as string, size)).rejects.toMatchObject({
        code: "invalid_option",
        message: UNSUPPORTED,
      });
    }
  });

  it("hands the probe the bytes, or the path, themselves", async () => {
    const path = await file();
    const fromPath = await openSource(path);
    expect(fromPath.probeInput).toEqual({ kind: "path", path });
    await fromPath.close();
    expect((await openSource(DATA)).probeInput).toEqual({ kind: "bytes", bytes: DATA });
  });

  it("releases the file handle on close", async () => {
    const source = await openSource(await file());
    await source.close();
    await expect(source.read(0, 10)).rejects.toMatchObject({ code: "EBADF" });
  });

  it.each([
    ["a path", async () => openSource(await file())],
    ["a Blob", async () => openSource(new Blob([DATA]))],
  ])(
    "gives up a read from %s when the call is aborted while the bytes are read",
    async (_name, make) => {
      const source = await make();
      const stop = new AbortController();
      const read = source.read(0, 10, stop.signal);
      stop.abort();
      await expect(read).rejects.toBeInstanceOf(AbortError);
      await source.close();
    },
  );

  it("refuses a pre-aborted read past the end of a file, which reads nothing", async () => {
    const source = await openSource(await file());
    await expect(source.read(100, 4, AbortSignal.abort())).rejects.toBeInstanceOf(AbortError);
    await source.close();
  });

  it("reads nothing from a Blob once the call is aborted", async () => {
    const slices: (number | undefined)[] = [];
    class Watched extends Blob {
      override slice(start?: number, end?: number, type?: string): Blob {
        slices.push(start);
        return super.slice(start, end, type);
      }
    }
    const source = await openSource(new Watched([DATA]));
    // The constructor takes one slice for the probe.
    slices.length = 0;
    await expect(source.read(0, 10, AbortSignal.abort())).rejects.toBeInstanceOf(AbortError);
    expect(slices).toEqual([]);
  });

  it("stops reading when the file is shorter than it was when opened", async () => {
    const path = await file();
    const source = await openSource(path);
    await writeFile(path, DATA.subarray(0, 20));
    expect((await source.read(0, 100)).byteLength).toBe(20);
    await source.close();
  });
});

describe("stream source", () => {
  it("needs the size up front", async () => {
    await expect(openSource(streamOf(DATA))).rejects.toMatchObject({
      code: "invalid_option",
      message: NEEDS_SIZE,
    });
  });

  it("accepts a size of one byte", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 1)), 1);
    expect([...(await source.read(0, 1))]).toEqual([0]);
    await source.close();
  });

  it("hands out a part as soon as its bytes are in, without waiting for more", async () => {
    const live = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(DATA.subarray(0, 40));
      },
    });
    const source = await openSource(live, 100);
    const stop = new AbortController();
    const timer = setTimeout(() => {
      stop.abort();
    }, 200);
    const part = await source.read(0, 40, stop.signal).catch((e: unknown) => e);
    clearTimeout(timer);
    expect(part).toEqual(DATA.subarray(0, 40));
    await source.close();
  });

  it("hands out parts in order, holding one part at a time", async () => {
    const source = await openSource(
      streamOf(DATA.subarray(0, 30), DATA.subarray(30, 70), DATA.subarray(70)),
      100,
    );
    expect(source.sequential).toBe(true);
    expect([...(await source.head(4))]).toEqual([0, 1, 2, 3]);
    expect([...(await source.read(0, 40))].length).toBe(40);
    expect([...(await source.read(40, 40))].slice(0, 2)).toEqual([40, 41]);
    expect([...(await source.read(80, 40))]).toEqual([...DATA.subarray(80)]);
    await source.close();
  });

  it("refuses an out-of-order read", async () => {
    const source = await openSource(streamOf(DATA), 100);
    await expect(source.read(10, 5)).rejects.toMatchObject({
      code: "stream_not_seekable",
      message: "A stream can only be uploaded in order, one part at a time.",
    });
    await source.close();
  });

  it("keeps a part and the leftover apart: neither pins the other's memory", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 90), DATA.subarray(90)), 100);
    const first = await source.read(0, 40);
    expect(first.buffer.byteLength).toBe(40);
    const second = await source.read(40, 40);
    expect(second.buffer.byteLength).toBe(40);
    expect([...first]).toEqual([...DATA.subarray(0, 40)]);
    expect([...second]).toEqual([...DATA.subarray(40, 80)]);
    expect([...(await source.read(80, 40))]).toEqual([...DATA.subarray(80)]);
    await source.close();
  });

  it("does not consume what head() looked at", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 10), DATA.subarray(10)), 100);
    expect([...(await source.head(30))]).toEqual([...DATA.subarray(0, 30)]);
    expect([...(await source.head(30))]).toEqual([...DATA.subarray(0, 30)]);
    expect([...(await source.read(0, 100))]).toEqual([...DATA]);
    await source.close();
  });

  it("fails after the last part when the stream has more than size", async () => {
    const source = await openSource(streamOf(DATA, DATA.subarray(0, 5)), 100);
    const error = await source.read(0, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "stream_size_mismatch",
      message: "The stream has more than the 100 bytes size says.",
    });
    await source.close();
  });

  it("fails on a trailing chunk that arrives after the last part was already buffered", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 60), DATA.subarray(60), DATA), 100);
    await source.read(0, 50);
    await expect(source.read(50, 50)).rejects.toMatchObject({ code: "stream_size_mismatch" });
    await source.close();
  });

  it("accepts a stream that is exactly size, with empty chunks around the data", async () => {
    const source = await openSource(streamOf(new Uint8Array(), DATA, new Uint8Array()), 100);
    expect((await source.read(0, 100)).byteLength).toBe(100);
    await source.close();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a stream size of %s as invalid_option",
    async (size) => {
      await expect(openSource(streamOf(DATA), size)).rejects.toMatchObject({
        code: "invalid_option",
        message: "size must be a whole number of bytes, 1 or more.",
      });
    },
  );

  it("fails when the stream ends before size", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 50)), 100);
    await source.read(0, 40);
    const error = await source.read(40, 60).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({
      code: "stream_size_mismatch",
      message: "The stream ended after 50 bytes; size says 100.",
    });
    await source.close();
  });

  it("stops waiting for a stream left open after exactly size bytes when the call is aborted", async () => {
    const open = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(DATA);
      },
    });
    const source = await openSource(open, 100);
    const stop = new AbortController();
    const read = source.read(0, 100, stop.signal).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect(await read).toBeInstanceOf(AbortError);
    await source.close();
  });

  it("refuses at once when the signal is already aborted, and handles the read it gave up", async () => {
    // A read that never settles, watched for a rejection handler: once the reader is released it
    // would reject, and with no handler that rejection would go unhandled.
    let handled = false;
    const never = new Promise<never>(() => undefined);
    const then = never.then.bind(never);
    const pending = Object.defineProperty(never, "then", {
      value: (onFulfilled?: unknown, onRejected?: unknown) => {
        if (typeof onRejected === "function") handled = true;
        return then(onFulfilled as undefined, onRejected as undefined);
      },
    });
    const stream = {
      getReader: () => ({ read: () => pending, releaseLock: () => undefined }),
    } as unknown as ReadableStream<Uint8Array>;
    const source = await openSource(stream, 100);
    expect(await source.read(0, 100, AbortSignal.abort()).catch((e: unknown) => e)).toBeInstanceOf(
      AbortError,
    );
    expect(handled).toBe(true);
    await source.close();
  });

  it("stops head() waiting on a stream that has stopped producing when the call is aborted", async () => {
    const source = await openSource(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(DATA.subarray(0, 4));
        },
      }),
      100,
    );
    const stop = new AbortController();
    const head = source.head(30, stop.signal).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect(await head).toBeInstanceOf(AbortError);
    await source.close();
  });
});

describe("a file that fails once it passed the stat", () => {
  const PREFIX = "cannot be read: it is missing, not a regular file or cannot be opened";

  it("raises file_unreadable with the OS error when the open fails", async () => {
    const path = await file();
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    fsHooks.open = () => Promise.reject(denied);
    const error = await openSource(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({
      code: "file_unreadable",
      message: `${path} ${PREFIX} (Error: EACCES: permission denied).`,
    });
    expect((error as Error).cause).toMatchObject({ code: "EACCES" });
  });

  it("closes the handle and raises file_unreadable with the OS error when its stat fails", async () => {
    const path = await file();
    let closes = 0;
    fsHooks.open = () =>
      Promise.resolve({
        stat: () => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })),
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
      });
    const error = await openSource(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({
      code: "file_unreadable",
      message: `${path} ${PREFIX} (Error: EIO: i/o error).`,
    });
    expect((error as Error).cause).toMatchObject({ code: "EIO" });
    expect(closes).toBe(1);
  });

  it("closes the handle and raises file_unreadable when what was opened is not a regular file", async () => {
    const path = await file();
    let closes = 0;
    fsHooks.open = () =>
      Promise.resolve({
        stat: () => Promise.resolve({ isFile: () => false, size: 100 }),
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
      });
    const error = await openSource(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect(error).toMatchObject({ code: "file_unreadable", message: `${path} ${PREFIX}.` });
    expect((error as Error).cause).toBeUndefined();
    expect(closes).toBe(1);
  });
});
