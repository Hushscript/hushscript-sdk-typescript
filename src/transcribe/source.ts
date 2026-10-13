/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream is stable in every Node 22 release we test; the rule's table lags */
import type { Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { PreflightError, UploadError, describeError } from "../errors.ts";
import { aborted } from "./common.ts";

export type FileInput = string | Blob | Uint8Array | ReadableStream<Uint8Array>;

/** What the duration probe reads: the file itself, so the parser sees the real thing and detects the format by content. */
type ProbeInput =
  | { kind: "path"; path: string }
  | { kind: "blob"; blob: Blob }
  | { kind: "bytes"; bytes: Uint8Array };

/** Byte ranges of the upload's file, read one part at a time so memory stays bounded. */
export interface Source {
  readonly size: number;
  /** Null for a stream, which is read once and cannot be probed. */
  readonly probeInput: ProbeInput | null;
  /** A stream is read once, in order, one part at a time. */
  readonly sequential: boolean;
  /** The first `length` bytes (fewer when the file is shorter), without consuming them. `signal` checks cancellation around reads. */
  head(length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** `signal` checks cancellation around reads and stops a wait on a stalled stream. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

function clampLength(size: number, offset: number, length: number): number {
  return Math.max(0, Math.min(length, size - offset));
}

class MemorySource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly probeInput: ProbeInput;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.size = bytes.byteLength;
    this.probeInput = { kind: "bytes", bytes };
  }

  head(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.read(0, length, signal);
  }

  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    return Promise.resolve(
      this.#bytes.subarray(offset, offset + clampLength(this.size, offset, length)),
    );
  }

  // Stryker disable next-line BlockStatement: every caller awaits close(), and awaiting undefined is the same as a resolved promise
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class BlobSource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly probeInput: ProbeInput;
  readonly #blob: Blob;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = blob.size;
    // A Blob's own type (or a file's extension) must not pick the parser.
    this.probeInput = { kind: "blob", blob: blob.slice(0, blob.size, "") };
  }

  head(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.read(0, length, signal);
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw aborted(signal);
    const end = offset + clampLength(this.size, offset, length);
    const bytes = new Uint8Array(await this.#blob.slice(offset, end).arrayBuffer());
    if (signal?.aborted) throw aborted(signal);
    return bytes;
  }

  // Stryker disable next-line BlockStatement: every caller awaits close(), and awaiting undefined is the same as a resolved promise
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FileSource implements Source {
  readonly size: number;
  readonly sequential = false;
  readonly probeInput: ProbeInput;
  readonly #handle: FileHandle;

  constructor(handle: FileHandle, path: string, size: number) {
    this.#handle = handle;
    this.size = size;
    this.probeInput = { kind: "path", path };
  }

  head(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.read(0, length, signal);
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw aborted(signal);
    const wanted = clampLength(this.size, offset, length);
    const buffer = new Uint8Array(wanted);
    let filled = 0;
    // Stryker disable next-line EqualityOperator: one more round reads zero bytes at the end and stops
    while (filled < wanted) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        wanted - filled,
        offset + filled,
      );
      if (signal?.aborted) throw aborted(signal);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

function streamSizeMismatch(message: string): UploadError {
  return new UploadError({ code: "stream_size_mismatch", message });
}

class StreamSource implements Source {
  readonly size: number;
  readonly sequential = true;
  readonly probeInput = null;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #position = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>, size: number) {
    this.#reader = stream.getReader();
    this.size = size;
  }

  /** One read, given up with the SDK's `AbortError` when `signal` fires; `close()` releases the reader and leaves the stream itself alone. */
  #next(
    signal: AbortSignal | undefined,
  ): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
    const pending = this.#reader.read();
    if (signal === undefined) return pending;
    if (signal.aborted) {
      pending.catch(() => undefined);
      return Promise.reject(aborted(signal));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(aborted(signal));
      };
      signal.addEventListener("abort", onAbort);
      pending.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  async #fill(length: number, signal?: AbortSignal): Promise<void> {
    while (this.#buffered < length && !this.#ended) {
      const { done, value } = await this.#next(signal);
      if (done) {
        this.#ended = true;
      } else {
        this.#chunks.push(value);
        this.#buffered += value.byteLength;
      }
    }
  }

  /**
   * The first `length` buffered bytes in one fresh array. A chunk that is only partly taken keeps a
   * copy of its rest, so the returned part and the leftover never share (or pin) each other's memory.
   */
  #take(length: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(Math.min(length, this.#buffered));
    let at = 0;
    let used = 0;
    for (const chunk of this.#chunks) {
      // Stryker disable next-line ConditionalExpression: a full part takes zero bytes from the next chunk, which at most copies it unchanged
      if (at === out.byteLength) break;
      const n = Math.min(chunk.byteLength, out.byteLength - at);
      out.set(chunk.subarray(0, n), at);
      at += n;
      if (n < chunk.byteLength) {
        if (consume) this.#chunks[used] = chunk.slice(n);
        break;
      }
      used += 1;
    }
    if (consume) {
      this.#chunks.splice(0, used);
      this.#buffered -= out.byteLength;
    }
    return out;
  }

  async head(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    await this.#fill(length, signal);
    return this.#take(length, false);
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (offset !== this.#position) {
      throw new UploadError({
        code: "stream_not_seekable",
        message: "A stream can only be uploaded in order, one part at a time.",
      });
    }
    const wanted = clampLength(this.size, offset, length);
    await this.#fill(wanted, signal);
    if (this.#buffered < wanted) {
      throw streamSizeMismatch(
        `The stream ended after ${String(offset + this.#buffered)} bytes; size says ${String(this.size)}.`,
      );
    }
    const part = this.#take(wanted, true);
    this.#position += wanted;
    if (this.#position === this.size) {
      // The size is what gets billed and completed: a longer stream would be cut off silently.
      await this.#fill(1, signal);
      if (this.#buffered > 0) {
        throw streamSizeMismatch(
          `The stream has more than the ${String(this.size)} bytes size says.`,
        );
      }
    }
    return part;
  }

  /** The stream belongs to the caller: releasing the lock leaves it uncanceled, unclosed and readable. */
  close(): Promise<void> {
    this.#reader.releaseLock();
    return Promise.resolve();
  }
}

function isStream(file: FileInput): file is ReadableStream<Uint8Array> {
  return typeof file === "object" && "getReader" in file;
}

function unreadable(path: string, cause?: unknown): PreflightError {
  return new PreflightError({
    code: "file_unreadable",
    message: `${path} cannot be read: it is missing, not a regular file or cannot be opened${cause === undefined ? "" : ` (${describeError(cause)})`}.`,
    cause,
  });
}

/**
 * The size of the regular file at `path`, looked up without opening it: opening a FIFO or a device
 * can block, so it is refused before that. A path that is missing, is not a regular file or cannot
 * be read raises `file_unreadable` with the OS error as the cause.
 */
export async function statFile(path: string): Promise<number> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (!info.isFile()) throw unreadable(path);
  return info.size;
}

async function openFile(path: string): Promise<FileSource> {
  await statFile(path);
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    throw unreadable(path, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unreadable(path);
    return new FileSource(handle, path, info.size);
  } catch (error) {
    await handle.close();
    throw error instanceof PreflightError ? error : unreadable(path, error);
  }
}

/** Opens `file` for reading. A stream needs `size`; every other input knows its own. */
export async function openSource(file: FileInput, size?: number): Promise<Source> {
  if (typeof file === "string") return openFile(file);
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
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new PreflightError({
        code: "invalid_option",
        message: "size must be a whole number of bytes, 1 or more.",
      });
    }
    return new StreamSource(file, size);
  }
  throw new PreflightError({
    code: "invalid_option",
    message: "file must be a path, a Blob, a Uint8Array or a ReadableStream.",
  });
}
