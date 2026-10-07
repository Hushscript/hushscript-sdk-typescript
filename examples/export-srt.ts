import { writeFile } from "node:fs/promises";
import { Hushscript } from "../src/index.ts";

const hs = new Hushscript();
const transcript = await hs.transcribe(process.argv[2] ?? "meeting.mp3");
const out = process.argv[3] ?? "meeting.srt";
await writeFile(out, transcript.toSRT());
console.log(`wrote ${out}`);
