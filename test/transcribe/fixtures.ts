import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Captured at import, before any test stubs the global fetch.
const realFetch = globalThis.fetch;
const MOCK = "http://127.0.0.1:4010";

let directory: Promise<string> | undefined;
const downloads = new Map<string, Promise<string>>();

async function download(path: string): Promise<Uint8Array> {
  const response = await realFetch(`${MOCK}/__files/${path}`);
  if (!response.ok) throw new Error(`mock answered ${String(response.status)} for ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A media fixture from the conformance mock, saved once to a scratch file. */
export function fixturePath(name: string): Promise<string> {
  let found = downloads.get(name);
  if (found === undefined) {
    directory ??= mkdtemp(join(tmpdir(), "hs-media-"));
    found = (async () => {
      const file = join(await directory, name);
      await writeFile(file, await download(`fixtures/media/${name}`));
      return file;
    })();
    downloads.set(name, found);
  }
  return found;
}

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return download(`fixtures/media/${name}`);
}

export async function durations(): Promise<Record<string, number>> {
  const bytes = await download("fixtures/media/durations.json");
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, number>;
}
