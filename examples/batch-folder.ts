import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Hushscript, HushscriptError } from "@hushscript/sdk";

const AUDIO = new Set([".mp3", ".m4a", ".mp4", ".mov", ".wav", ".flac", ".ogg", ".opus"]);
const folder = process.argv[2] ?? "recordings";
const out = process.argv[3] ?? "transcripts";

const hs = new Hushscript();
await mkdir(out, { recursive: true });
for (const name of (await readdir(folder)).sort()) {
  if (!AUDIO.has(extname(name).toLowerCase())) continue;
  try {
    // Creates are paced for you (4 a minute), so a long folder just takes a while.
    const transcript = await hs.transcribe(join(folder, name));
    await writeFile(join(out, `${basename(name, extname(name))}.txt`), transcript.toText());
    console.log(`done ${name}`);
  } catch (error) {
    if (!(error instanceof HushscriptError)) throw error;
    console.log(`failed ${name}: ${error.code}${error.hint === null ? "" : ` (${error.hint})`}`);
    process.exitCode = 1;
  }
}
