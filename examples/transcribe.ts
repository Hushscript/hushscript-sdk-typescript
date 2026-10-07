import { Hushscript, HushscriptError } from "@hushscript/sdk";

try {
  const hs = new Hushscript();
  const transcript = await hs.transcribe(process.argv[2] ?? "meeting.mp3", {
    title: "Weekly sync",
  });
  console.log(`${transcript.title}: ${String(transcript.utterances.length)} utterances`);
  console.log(transcript.text);
} catch (error) {
  if (!(error instanceof HushscriptError)) throw error;
  console.log(`${error.code}: ${error.hint ?? error.message}`);
  process.exitCode = 1;
}
