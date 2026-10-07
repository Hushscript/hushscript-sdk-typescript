import { writeFile } from "node:fs/promises";
import { Hushscript, HushscriptError } from "@hushscript/sdk";

const source = process.argv[2] ?? "meeting.mp3";
const out = process.argv[3] ?? "meeting.srt";
try {
  const hs = new Hushscript();
  const transcript = await hs.transcribe(source);
  await writeFile(out, transcript.toSRT());
  console.log(`wrote ${out}`);
} catch (error) {
  if (!(error instanceof HushscriptError)) throw error;
  console.log(`${error.code}: ${error.hint ?? error.message}`);
  process.exitCode = 1;
}
