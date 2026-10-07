import { Hushscript } from "../src/index.ts";

const hs = new Hushscript();
const balance = await hs.balance();
// Held minutes are already taken out of `minutes`; do not subtract them again.
console.log(
  `${String(balance.minutes)} minutes to spend, ${String(balance.heldSeconds)} s held by running jobs`,
);

let shown = 0;
for await (const transcript of hs.transcripts.list({ pageSize: 5 })) {
  console.log(`${transcript.id}  ${transcript.title}`);
  if ((shown += 1) === 5) break;
}
// Transcripts that are still processing are jobs, not transcripts yet.
for await (const job of hs.jobs.list({ active: true })) console.log(`${job.id}  ${job.state}`);
