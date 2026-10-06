/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnsupportedMediaError } from "../../src/errors";
import { probeDuration } from "../../src/transcribe/probe";
import { openSource } from "../../src/transcribe/source";
import { durations, fixtureBytes, fixturePath } from "./fixtures";

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
  });

  it("raises duration_unreadable for a stream, which cannot be probed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    });
    const source = await openSource(stream, 10);
    await expect(probeDuration(source)).rejects.toMatchObject({ code: "duration_unreadable" });
    await source.close();
  });
});
