/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
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
