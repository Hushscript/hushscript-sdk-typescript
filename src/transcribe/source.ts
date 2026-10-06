/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import { open, type FileHandle } from "node:fs/promises";
import { PreflightError, UploadError } from "../errors.ts";

export type FileInput = string | Blob | Uint8Array | ReadableStream<Uint8Array>;

/** Byte ranges of the upload's file, read one part at a time so memory stays bounded. */
export interface Source {
  readonly size: number;
  /** A stream is read once, in order, one part at a time. */
  readonly sequential: boolean;
  /** The first `length` bytes (fewer when the file is shorter), without consuming them. */
  head(length: number): Promise<Uint8Array>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

function clampLength(size: number, offset: number, length: number): number {
  return Math.max(0, Math.min(length, size - offset));
}

class MemorySource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.size = bytes.byteLength;
  }

  head(length: number): Promise<Uint8Array> {
    return this.read(0, length);
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(
      this.#bytes.subarray(offset, offset + clampLength(this.size, offset, length)),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class BlobSource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly #blob: Blob;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = blob.size;
  }

  head(length: number): Promise<Uint8Array> {
    return this.read(0, length);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = offset + clampLength(this.size, offset, length);
    return new Uint8Array(await this.#blob.slice(offset, end).arrayBuffer());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FileSource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly #handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  head(length: number): Promise<Uint8Array> {
    return this.read(0, length);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const wanted = clampLength(this.size, offset, length);
    const buffer = new Uint8Array(wanted);
    let filled = 0;
    while (filled < wanted) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        wanted - filled,
        offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === wanted ? buffer : buffer.subarray(0, filled);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

class StreamSource implements Source {
  readonly size: number;
  readonly sequential = true;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #position = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>, size: number) {
    this.#reader = stream.getReader();
    this.size = size;
  }

  async #fill(length: number): Promise<void> {
    while (this.#buffered < length && !this.#ended) {
      const { done, value } = await this.#reader.read();
      if (done) {
        this.#ended = true;
      } else if (value.byteLength > 0) {
        this.#chunks.push(value);
        this.#buffered += value.byteLength;
      }
    }
  }

  async head(length: number): Promise<Uint8Array> {
    await this.#fill(length);
    const all = concat(this.#chunks, this.#buffered);
    this.#chunks = [all];
    return all.subarray(0, length);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset !== this.#position) {
      throw new UploadError({
        code: "stream_not_seekable",
        message: "A stream can only be uploaded in order, one part at a time.",
      });
    }
    const wanted = clampLength(this.size, offset, length);
    await this.#fill(wanted);
    const all = concat(this.#chunks, this.#buffered);
    if (all.byteLength < wanted) {
      throw new UploadError({
        code: "stream_size_mismatch",
        message: `The stream ended after ${String(offset + all.byteLength)} bytes; size says ${String(this.size)}.`,
      });
    }
    this.#chunks = all.byteLength > wanted ? [all.subarray(wanted)] : [];
    this.#buffered = all.byteLength - wanted;
    this.#position += wanted;
    return all.subarray(0, wanted);
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

function isStream(file: FileInput): file is ReadableStream<Uint8Array> {
  return typeof file === "object" && "getReader" in file;
}

/** Opens `file` for reading. A stream needs `size`; every other input knows its own. */
export async function openSource(file: FileInput, size?: number): Promise<Source> {
  if (typeof file === "string") {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new PreflightError({ code: "invalid_option", message: `${file} is not a file.` });
      return new FileSource(handle, info.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  if (file instanceof Uint8Array) return new MemorySource(file);
  if (file instanceof Blob) return new BlobSource(file);
  if (isStream(file)) {
    if (size === undefined) {
      throw new PreflightError({
        code: "invalid_option",
        message:
          "A stream input needs size (and durationSeconds); the SDK will not buffer an unbounded stream.",
      });
    }
    return new StreamSource(file, size);
  }
  throw new PreflightError({
    code: "invalid_option",
    message: "file must be a path, a Blob, a Uint8Array or a ReadableStream.",
  });
}
