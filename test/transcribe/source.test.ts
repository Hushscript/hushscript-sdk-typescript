/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreflightError, UploadError } from "../../src/errors";
import { openSource } from "../../src/transcribe/source";

const DATA = Uint8Array.from({ length: 100 }, (_, i) => i);

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

  it("refuses a directory", async () => {
    await expect(openSource(tmpdir())).rejects.toBeInstanceOf(PreflightError);
  });

  it("refuses anything that is not a path, bytes, a Blob or a stream", async () => {
    await expect(openSource(42 as unknown as string)).rejects.toMatchObject({
      code: "invalid_option",
    });
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
    await expect(openSource(streamOf(DATA))).rejects.toMatchObject({ code: "invalid_option" });
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
    await expect(source.read(10, 5)).rejects.toMatchObject({ code: "stream_not_seekable" });
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
    expect((error as UploadError).code).toBe("stream_size_mismatch");
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
      });
    },
  );

  it("fails when the stream ends before size", async () => {
    const source = await openSource(streamOf(DATA.subarray(0, 50)), 100);
    const error = await source.read(0, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe("stream_size_mismatch");
    await source.close();
  });
});
