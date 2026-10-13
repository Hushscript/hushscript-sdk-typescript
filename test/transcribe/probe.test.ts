/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import * as metadata from "music-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbortError, UnsupportedMediaError } from "../../src/errors";
import { probeDuration } from "../../src/transcribe/probe";
import { openSource, type Source } from "../../src/transcribe/source";
import { durations, fixtureBytes, fixturePath } from "./fixtures";

vi.mock("music-metadata", async (importOriginal) => {
  const original = await importOriginal<typeof metadata>();
  return { ...original, parseBlob: vi.fn(original.parseBlob) };
});

describe("probeDuration", () => {
  it("is within a second of the true duration on every fixture, and never below it once rounded up", async () => {
    const expected = await durations();
    for (const [name, seconds] of Object.entries(expected)) {
      const source = await openSource(await fixturePath(name));
      try {
        const probed = await probeDuration(source).catch((error: unknown) => {
          throw new Error(`${name}: ${String(error)}`, { cause: error });
        });
        expect(Math.ceil(probed), name).toBeGreaterThanOrEqual(seconds);
        expect(probed - seconds, name).toBeLessThanOrEqual(1);
      } finally {
        await source.close();
      }
    }
  });

  it("hands the caller's signal to its reads, and an abort is not an unreadable file", async () => {
    const inner = await openSource(await fixtureBytes("opus-20s.opus"));
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const watching: Source = {
      size: inner.size,
      probeInput: inner.probeInput,
      sequential: false,
      head: (length, signal) => {
        seen.push(signal);
        return inner.head(length, signal);
      },
      read: (offset, length, signal) => inner.read(offset, length, signal),
      close: () => inner.close(),
    };
    await probeDuration(watching, controller.signal);
    expect(seen).toEqual([controller.signal]);

    const late = new AbortController();
    const stalled: Source = {
      ...watching,
      head: () => {
        late.abort("caller stopped");
        return Promise.reject(new Error("read cut short"));
      },
    };
    await expect(probeDuration(stalled, late.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "caller stopped",
    });
    await inner.close();
  });

  it.each(["path", "blob", "bytes"] as const)(
    "does no parser reads for a pre-aborted %s probe",
    async (kind) => {
      const bytes = await fixtureBytes("vbr-noxing-20s.mp3");
      const source = await openSource(
        kind === "path"
          ? await fixturePath("vbr-noxing-20s.mp3")
          : kind === "blob"
            ? new Blob([bytes])
            : bytes,
      );
      const read = vi.spyOn(source, "read");
      const stop = new AbortController();
      stop.abort("caller stopped");
      try {
        await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
          name: "AbortError",
          cause: "caller stopped",
        });
        expect(read).not.toHaveBeenCalled();
      } finally {
        await source.close();
      }
    },
  );

  it.each(["path", "blob", "bytes"] as const)(
    "stops an active %s duration scan at a read boundary",
    async (kind) => {
      const bytes = await fixtureBytes("vbr-noxing-20s.mp3");
      const source = await openSource(
        kind === "path"
          ? await fixturePath("vbr-noxing-20s.mp3")
          : kind === "blob"
            ? new Blob([bytes])
            : bytes,
      );
      const stop = new AbortController();
      const original = source.read.bind(source);
      let scan = false;
      let afterAbort = 0;
      vi.spyOn(source, "read").mockImplementation(async (offset, length, signal) => {
        expect(signal).toBe(stop.signal);
        if (stop.signal.aborted) afterAbort += 1;
        const bytes = await original(offset, length, signal);
        if (scan) stop.abort();
        // The MP3 header check precedes the second (full-duration) parse.
        if (length === 4096) scan = true;
        return bytes;
      });
      try {
        await expect(probeDuration(source, stop.signal)).rejects.toBeInstanceOf(AbortError);
        expect(scan).toBe(true);
        expect(stop.signal.aborted).toBe(true);
        expect(afterAbort).toBe(0);
        expect((await original(0, 4)).length).toBe(4);
      } finally {
        await source.close();
      }
    },
  );

  it.each([
    ["path", "vbr-noxing-20s.mp3"],
    ["blob", "vbr-noxing-20s.mp3"],
    ["bytes", "vbr-noxing-20s.mp3"],
    ["path", "vbr-noxing-61s.mp3"],
    ["blob", "vbr-noxing-61s.mp3"],
    ["bytes", "vbr-noxing-61s.mp3"],
  ] as const)("lets an externally scheduled abort stop a %s scan of %s", async (kind, fixture) => {
    const bytes = await fixtureBytes(fixture);
    const source = await openSource(
      kind === "path" ? await fixturePath(fixture) : kind === "blob" ? new Blob([bytes]) : bytes,
    );
    const stop = new AbortController();
    const original = source.read.bind(source);
    let scheduled = false;
    let afterAbort = 0;
    vi.spyOn(source, "read").mockImplementation((offset, length, signal) => {
      if (stop.signal.aborted) afterAbort += 1;
      if (length === 4096 && !scheduled) {
        scheduled = true;
        setImmediate(() => {
          stop.abort();
        });
      }
      return original(offset, length, signal);
    });
    try {
      await expect(probeDuration(source, stop.signal)).rejects.toBeInstanceOf(AbortError);
      expect(scheduled).toBe(true);
      expect(stop.signal.aborted).toBe(true);
      expect(afterAbort).toBe(0);
      expect((await original(0, 4)).length).toBe(4);
    } finally {
      await source.close();
    }
  });

  it("parses bounded source ranges without copying or parsing probeInput bytes", async () => {
    const source = await openSource(await fixtureBytes("vbr-noxing-61s.mp3"));
    const read = vi.spyOn(source, "read");
    const watching: Source = {
      size: source.size,
      probeInput: { kind: "bytes", bytes: new Uint8Array() },
      sequential: false,
      head: (length, signal) => source.head(length, signal),
      read: (offset, length, signal) => source.read(offset, length, signal),
      close: () => source.close(),
    };
    try {
      expect(Math.abs((await probeDuration(watching)) - 61.09)).toBeLessThan(0.2);
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(read.mock.calls.some(([offset]) => offset > 0)).toBe(true);
      for (const [offset, length] of read.mock.calls) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(length).toBeLessThan(source.size);
        expect(offset + length).toBeLessThanOrEqual(source.size);
      }
    } finally {
      await source.close();
    }
  });

  it("waits for an in-flight read before rejecting cancellation and starts no further reads", async () => {
    const source = await openSource(await fixtureBytes("vbr-noxing-20s.mp3"));
    const stop = new AbortController();
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseRead = (): void => undefined;
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const original = source.read.bind(source);
    let settled = false;
    const read = vi.spyOn(source, "read").mockImplementation(async (offset, length, signal) => {
      expect(signal).toBe(stop.signal);
      const bytes = await original(offset, length);
      markStarted();
      await release;
      return bytes;
    });
    const pending = probeDuration(source, stop.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
      cause: "caller stopped",
    });
    try {
      await started;
      stop.abort("caller stopped");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
      releaseRead();
      await rejected;
      expect(read).toHaveBeenCalledTimes(1);
      expect((await original(0, 4)).length).toBe(4);
    } finally {
      releaseRead();
      await source.close();
    }
  });

  it("reads Blob and Uint8Array inputs the same way as a path", async () => {
    const bytes = await fixtureBytes("vbr-noxing-20s.mp3");
    const fromFile = await openSource(await fixturePath("vbr-noxing-20s.mp3"));
    const reference = await probeDuration(fromFile);
    await fromFile.close();
    expect(await probeDuration(await openSource(bytes))).toBeCloseTo(reference, 3);
    expect(await probeDuration(await openSource(new Blob([bytes])))).toBeCloseTo(reference, 3);
  });

  it("reads the Opus pre-skip from the file's OpusHead, not from a constant", async () => {
    const original = await fixtureBytes("opus-20s.opus");
    const patched = original.slice();
    const head = Buffer.from(patched).indexOf("OpusHead");
    expect(head).toBeGreaterThan(-1);
    const stored = (patched[head + 10] ?? 0) | ((patched[head + 11] ?? 0) << 8);
    expect(stored).toBe(312);
    // 80 ms of pre-skip instead of 6.5 ms: music-metadata subtracts it, the probe must add the same amount back.
    patched[head + 10] = 3840 & 0xff;
    patched[head + 11] = 3840 >> 8;
    const base = await probeDuration(await openSource(original));
    const shifted = await probeDuration(await openSource(patched));
    expect(shifted).toBeCloseTo(base, 3);
  });

  it("detects the format by content for a path, a Blob and bytes, whatever their name or type say", async () => {
    const opus = await fixtureBytes("opus-20s.opus");
    const reference = await probeDuration(await openSource(opus));
    const directory = await mkdtemp(join(tmpdir(), "hs-probe-"));
    try {
      const path = join(directory, "really-opus.mp3");
      await writeFile(path, opus);
      const sources = [
        await openSource(path),
        await openSource(new Blob([opus], { type: "audio/mpeg" })),
        await openSource(new File([opus], "lie.mp3", { type: "audio/mpeg" })),
        await openSource(opus),
      ];
      for (const source of sources) {
        expect(source.probeInput?.kind).toBeDefined();
        expect(await probeDuration(source)).toBeCloseTo(reference, 3);
        await source.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hands the parser an untyped Blob even when the caller's Blob has a type", async () => {
    const bytes = await fixtureBytes("cbr-20s.mp3");
    const source = await openSource(new Blob([bytes], { type: "video/webm" }));
    expect(source.probeInput).toMatchObject({ kind: "blob" });
    expect((source.probeInput as { blob: Blob }).blob.type).toBe("");
    expect((source.probeInput as { blob: Blob }).blob.size).toBe(bytes.byteLength);
  });

  it("counts the frames of an MP3 without a Xing header, where the header-only estimate is off", async () => {
    const noXing = await openSource(await fixturePath("vbr-noxing-61s.mp3"));
    expect(Math.abs((await probeDuration(noXing)) - 61.09)).toBeLessThan(0.2);
    await noXing.close();
  });

  it("raises duration_unreadable for bytes that are not audio", async () => {
    const error = await probeDuration(await openSource(new Uint8Array(2000))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsupportedMediaError);
    expect((error as UnsupportedMediaError).code).toBe("duration_unreadable");
    const cause = (error as UnsupportedMediaError).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect((error as UnsupportedMediaError).message).toBe(
      `Could not read the duration (${cause.name}: ${cause.message}); pass durationSeconds.`,
    );
  });

  it("raises AbortError, not duration_unreadable, for a stream probed with an aborted signal", async () => {
    const source = await openSource(new ReadableStream<Uint8Array>(), 10);
    const stop = new AbortController();
    stop.abort("caller stopped");
    await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "caller stopped",
    });
  });

  it("raises duration_unreadable for a stream, which cannot be probed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    });
    const source = await openSource(stream, 10);
    const error = await probeDuration(source).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "duration_unreadable" });
    // Nothing was thrown underneath, so there is no original to name.
    expect((error as UnsupportedMediaError).message).toBe(
      "Could not read the duration; pass durationSeconds.",
    );
    expect((error as UnsupportedMediaError).cause).toBeUndefined();
    await source.close();
  });
});

describe("probe parser boundary contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(metadata.parseBlob).mockReset();
  });

  function parsed(format: Partial<metadata.IAudioMetadata["format"]>): metadata.IAudioMetadata {
    return {
      format: { trackInfo: [], tagTypes: [], ...format },
      native: {},
      common: {
        track: { no: null, of: null },
        disk: { no: null, of: null },
        movementIndex: { no: null, of: null },
      },
      quality: { warnings: [] },
    };
  }

  it.each([undefined, 0, -1, NaN, Infinity, -Infinity])(
    "rejects invalid parser duration %s",
    async (duration) => {
      vi.spyOn(metadata, "parseBlob").mockResolvedValue(
        parsed(duration === undefined ? {} : { duration }),
      );
      const source = await openSource(new Uint8Array(64));
      const error = (await probeDuration(source).catch((e: unknown) => e)) as UnsupportedMediaError;
      expect(error).toBeInstanceOf(UnsupportedMediaError);
      expect(error.code).toBe("duration_unreadable");
      expect(error.cause).toBeUndefined();
    },
  );

  it("falls back only when duration is absent and keeps a positive fractional duration", async () => {
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockResolvedValueOnce(parsed({ container: "WAVE" }))
      .mockResolvedValueOnce(parsed({ container: "WAVE", duration: 0.125 }));
    expect(await probeDuration(await openSource(new Uint8Array(64)))).toBe(0.125);
    expect(parse.mock.calls.map(([, options]) => options)).toEqual([
      { duration: false, skipCovers: true },
      { duration: true, skipCovers: true },
    ]);
  });

  it("clamps nested parser slices and returns independent range bytes", async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    const source = await openSource(bytes);
    const read = vi.spyOn(source, "read");
    vi.spyOn(metadata, "parseBlob").mockImplementation(async (blob) => {
      expect(blob.size).toBe(16);
      expect(blob.type).toBe("");
      const range = blob.slice(3, 12).slice(-5, -1);
      expect(range.size).toBe(4);
      const first = new Uint8Array(await range.arrayBuffer());
      expect([...first]).toEqual([7, 8, 9, 10]);
      first.fill(255);
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([7, 8, 9, 10]);
      expect(blob.slice(-100, 100).size).toBe(16);
      expect(blob.slice(12, 3).size).toBe(0);
      expect(blob.slice(100).size).toBe(0);
      expect([...new Uint8Array(await blob.slice().arrayBuffer())]).toEqual([...bytes]);
      return parsed({ duration: 20 });
    });
    expect(await probeDuration(source)).toBe(20);
    expect(read.mock.calls).toEqual([
      [7, 4, undefined],
      [7, 4, undefined],
      [0, 16, undefined],
    ]);
  });

  it("rejects a parser range after cancellation without touching the source", async () => {
    const source = await openSource(new Uint8Array(16));
    const read = vi.spyOn(source, "read");
    const stop = new AbortController();
    vi.spyOn(metadata, "parseBlob").mockImplementation(async (blob) => {
      stop.abort("range cancelled");
      await expect(blob.slice(0, 4).arrayBuffer()).rejects.toMatchObject({
        name: "AbortError",
        cause: "range cancelled",
      });
      return parsed({ duration: 20 });
    });
    await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "range cancelled",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([new Error("broken range"), "broken range"])(
    "preserves and describes a parser failure %s",
    async (cause) => {
      vi.spyOn(metadata, "parseBlob").mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- parser failures can be non-Error values
        throw cause;
      });
      const error = await probeDuration(await openSource(new Uint8Array(16))).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UnsupportedMediaError);
      if (typeof cause === "string") expect((error as UnsupportedMediaError).cause).toBe(cause);
      else
        expect((error as UnsupportedMediaError).cause).toMatchObject({
          name: cause.name,
          message: cause.message,
        });
      expect((error as UnsupportedMediaError).message).toContain(
        typeof cause === "string" ? "thrown string: broken range" : "Error: broken range",
      );
    },
  );

  it.each([
    [0xfb, 0, 36, "Xing"],
    [0xfb, 0xc0, 21, "Info"],
    [0xfa, 0, 38, "Xing"],
    [0xfa, 0xc0, 23, "Info"],
    [0xf3, 0, 21, "Xing"],
    [0xf3, 0xc0, 13, "Info"],
    [0xf2, 0, 23, "Xing"],
    [0xf2, 0xc0, 15, "Info"],
    [0xe3, 0, 21, "Xing"],
    [0xe3, 0xc0, 13, "Info"],
    [0xfb, 0, 36, "VBRI"],
  ] as const)("uses MPEG header layout %s/%s at %s (%s)", async (version, channel, offset, tag) => {
    const frame = new Uint8Array(200);
    frame.set([0xff, version, 0x90, channel]);
    frame.set(new TextEncoder().encode(tag), offset);
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementation((_blob, options) =>
        Promise.resolve(parsed({ container: "MPEG", duration: options?.duration ? 29 : 17 })),
      );
    expect(await probeDuration(await openSource(frame))).toBe(17);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("counts the frames of an MPEG frame with no Xing, Info or VBRI tag", async () => {
    const frame = new Uint8Array(200);
    frame.set([0xff, 0xfb, 0x90, 0]);
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementation((_blob, options) =>
        Promise.resolve(parsed({ container: "MPEG", duration: options?.duration ? 29 : 17 })),
      );
    expect(await probeDuration(await openSource(frame))).toBe(29);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0xfe, 0xfb],
    [0xff, 0x1b],
    [0xff, 0xf9],
    [0xff, 0xeb],
    [0, 0],
  ])("scans past a non-frame prefix %s/%s", async (sync, version) => {
    const bytes = new Uint8Array(128);
    bytes.set([sync, version, 0x90, 0]);
    bytes.set([0xff, 0xfb, 0x90, 0], 64);
    bytes.set(new TextEncoder().encode("Xing"), 100);
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockResolvedValue(parsed({ container: "MPEG", duration: 17 }));
    expect(await probeDuration(await openSource(bytes))).toBe(17);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it.each([0, 0x10])("skips consecutive syncsafe ID3 sizes with footer flag %s", async (flags) => {
    // A sparse source represents a large metadata tag without allocating its payload.
    const length = 2 ** 21 + 2 * 2 ** 14 + 3 * 128 + 4;
    const next = 10 + length + (flags === 0 ? 0 : 10);
    const frameAt = next + 10 + 129;
    const header = Uint8Array.from([73, 68, 51, 4, 0, flags, 1, 2, 3, 4]);
    const second = Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 1, 1]);
    const frame = new Uint8Array(64);
    frame.set([0xff, 0xfb, 0x90, 0]);
    frame.set(new TextEncoder().encode("Xing"), 36);
    const read = vi.fn((offset: number) =>
      Promise.resolve(
        offset === 0
          ? header
          : offset === next
            ? second
            : offset === frameAt
              ? frame
              : new Uint8Array(),
      ),
    );
    const source: Source = {
      size: frameAt + 64,
      sequential: false,
      probeInput: { kind: "bytes", bytes: frame },
      read,
      head: () => Promise.resolve(header),
      close: () => Promise.resolve(),
    };
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementation((_blob, options) =>
        Promise.resolve(parsed({ container: "MPEG", duration: options?.duration ? 29 : 17 })),
      );
    expect(await probeDuration(source)).toBe(17);
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, next, frameAt, frameAt]);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("bounds consecutive ID3 traversal to four tags", async () => {
    const header = Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
    const read = vi.fn((offset: number, length: number) => {
      if (offset > 40) throw new Error("ID3 traversal exceeded the header budget");
      return Promise.resolve(length === 10 ? header : new Uint8Array(64));
    });
    const source: Source = {
      size: 64,
      sequential: false,
      probeInput: { kind: "bytes", bytes: header },
      read,
      head: () => Promise.resolve(header),
      close: () => Promise.resolve(),
    };
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementation((_blob, options) =>
        Promise.resolve(parsed({ container: "MPEG", duration: options?.duration ? 29 : 17 })),
      );
    expect(await probeDuration(source)).toBe(29);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([offset, length]) => [offset, length])).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
      [30, 10],
      [40, 4096],
    ]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("does not skip a truncated ID3 header", async () => {
    const header = Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 1]);
    const read = vi.fn(() => Promise.resolve(header));
    const source: Source = {
      size: 9,
      sequential: false,
      probeInput: { kind: "bytes", bytes: header },
      read,
      head: () => Promise.resolve(header),
      close: () => Promise.resolve(),
    };
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementation((_blob, options) =>
        Promise.resolve(parsed({ container: "MPEG", duration: options?.duration ? 29 : 17 })),
      );
    expect(await probeDuration(source)).toBe(29);
    expect(read).toHaveBeenNthCalledWith(1, 0, 10, undefined);
    expect(read).toHaveBeenNthCalledWith(2, 0, 4096, undefined);
    expect(read).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it.each(["Opus", "OPUS", "opus"])("adds little-endian pre-skip for codec %s", async (codec) => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("OpusHead"), 7);
    bytes.set([0x34, 0x12], 17);
    vi.spyOn(metadata, "parseBlob").mockResolvedValue(parsed({ codec, duration: 20 }));
    expect(await probeDuration(await openSource(bytes))).toBeCloseTo(20 + 0x1234 / 48000, 10);
  });

  it("reads a pre-skip that ends the head exactly", async () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode("OpusHead"), 1, 2, 0x34, 0x12]);
    vi.spyOn(metadata, "parseBlob").mockResolvedValue(parsed({ codec: "Opus", duration: 20 }));
    expect(await probeDuration(await openSource(bytes))).toBeCloseTo(20 + 0x1234 / 48000, 10);
  });

  it("adds no pre-skip for a codec other than Opus, even with an OpusHead in the head", async () => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("OpusHead"), 7);
    bytes.set([0x34, 0x12], 17);
    vi.spyOn(metadata, "parseBlob").mockResolvedValue(parsed({ codec: "FLAC", duration: 20 }));
    expect(await probeDuration(await openSource(bytes))).toBe(20);
  });

  it.each([
    new Uint8Array(64),
    new Uint8Array(64).fill(0x55),
    new TextEncoder().encode("OpusHead\u0000\u0000\u0001"),
  ])("leaves duration intact when pre-skip is unavailable", async (bytes) => {
    vi.spyOn(metadata, "parseBlob").mockResolvedValue(parsed({ codec: "Opus", duration: 20 }));
    expect(await probeDuration(await openSource(bytes))).toBe(20);
  });
});

describe("probe cancellation windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(metadata.parseBlob).mockReset();
  });

  function parsed(format: Partial<metadata.IAudioMetadata["format"]>): metadata.IAudioMetadata {
    return {
      format: { trackInfo: [], tagTypes: [], ...format },
      native: {},
      common: {
        track: { no: null, of: null },
        disk: { no: null, of: null },
        movementIndex: { no: null, of: null },
      },
      quality: { warnings: [] },
    };
  }

  it("notices an abort that lands while a parser range yields after its read", async () => {
    const inner = await openSource(Uint8Array.from({ length: 16 }, (_, i) => i));
    const stop = new AbortController();
    const read = vi.fn((offset: number, length: number, signal?: AbortSignal) => {
      setImmediate(() => {
        stop.abort("late");
      });
      return inner.read(offset, length, signal);
    });
    const source: Source = {
      size: inner.size,
      probeInput: inner.probeInput,
      sequential: false,
      head: (length, signal) => inner.head(length, signal),
      read,
      close: () => inner.close(),
    };
    let range: unknown;
    vi.spyOn(metadata, "parseBlob").mockImplementation(async (blob) => {
      range = await blob
        .slice(0, 4)
        .arrayBuffer()
        .catch((e: unknown) => e);
      return parsed({ duration: 20 });
    });
    await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "late",
    });
    expect(range).toMatchObject({ name: "AbortError", cause: "late" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not start the full parse once an abort lands between the two parses", async () => {
    const stop = new AbortController();
    const parse = vi
      .spyOn(metadata, "parseBlob")
      .mockImplementationOnce(() => {
        setImmediate(() => {
          stop.abort("between");
        });
        return Promise.resolve(parsed({ container: "WAVE" }));
      })
      .mockResolvedValue(parsed({ container: "WAVE", duration: 20 }));
    await expect(
      probeDuration(await openSource(new Uint8Array(64)), stop.signal),
    ).rejects.toMatchObject({ name: "AbortError", cause: "between" });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("reads nothing more once the signal fired during a parse that still resolved", async () => {
    const frame = new Uint8Array(200);
    frame.set([0xff, 0xfb, 0x90, 0]);
    const source = await openSource(frame);
    const read = vi.spyOn(source, "read");
    const stop = new AbortController();
    vi.spyOn(metadata, "parseBlob").mockImplementation(() => {
      stop.abort("mid parse");
      return Promise.resolve(parsed({ container: "MPEG", duration: 17 }));
    });
    await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "mid parse",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("raises the caller's AbortError when the parser fails after the signal fired", async () => {
    const stop = new AbortController();
    vi.spyOn(metadata, "parseBlob").mockImplementation(() => {
      stop.abort("gave up");
      return Promise.reject(new Error("range failed"));
    });
    await expect(
      probeDuration(await openSource(new Uint8Array(64)), stop.signal),
    ).rejects.toMatchObject({ name: "AbortError", cause: "gave up" });
  });

  it("passes on an AbortError from below while the caller's signal is still live", async () => {
    const own = new AbortError({ message: "The source gave up." });
    vi.spyOn(metadata, "parseBlob").mockRejectedValue(own);
    const error = await probeDuration(
      await openSource(new Uint8Array(64)),
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(error).toBe(own);
  });

  it("raises AbortError when the signal fires during the Opus pre-skip read", async () => {
    const inner = await openSource(new Uint8Array(64));
    const stop = new AbortController();
    const source: Source = {
      size: inner.size,
      probeInput: inner.probeInput,
      sequential: false,
      read: (offset, length, signal) => inner.read(offset, length, signal),
      close: () => inner.close(),
      head: async (length, signal) => {
        const bytes = await inner.head(length, signal);
        stop.abort("during pre-skip");
        return bytes;
      },
    };
    vi.spyOn(metadata, "parseBlob").mockResolvedValue(parsed({ codec: "Opus", duration: 20 }));
    await expect(probeDuration(source, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: "during pre-skip",
    });
  });
});
