import { Hushscript } from "../src/index.ts";

const hs = new Hushscript();
const transcript = await hs.transcribe(process.argv[2] ?? "meeting.mp3", { title: "Weekly sync" });
console.log(`${transcript.title}: ${String(transcript.utterances.length)} utterances`);
console.log(transcript.text);
