// Runs every file in examples/ against the conformance mock this container shares a network with.
// Each example gets a fresh mock scenario, a sample recording and the arguments it documents.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const baseUrl = process.env["HUSHSCRIPT_BASE_URL"] ?? "http://127.0.0.1:4010";
// A made-up token: the mock accepts any bearer that starts with "hsr".
const token = `hsr1:eu:pat.${"0".repeat(32)}.${"0".repeat(64)}`;
const work = "/tmp/examples";

/** @param {string} path @param {unknown} [body] */
async function mock(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
  return response;
}

mkdirSync(join(work, "recordings"), { recursive: true });
const sample = join(work, "sample.mp3");
const download = await mock("/__files/fixtures/media/cbr-20s.mp3");
writeFileSync(sample, new Uint8Array(await download.arrayBuffer()));
copyFileSync(sample, join(work, "recordings", "one.mp3"));
copyFileSync(sample, join(work, "recordings", "two.mp3"));

/**
 * What each example is run with: the arguments it documents.
 * @type {Record<string, string[]>}
 */
const args = {
  "transcribe.ts": [sample],
  "export-srt.ts": [sample, join(work, "meeting.srt")],
  "batch-folder.ts": [join(work, "recordings"), join(work, "transcripts")],
  "buy.ts": ["300min"],
  "agent-signup.ts": ["2026-10-01"],
};

let failed = false;
for (const file of readdirSync("examples")
  .filter((name) => name.endsWith(".ts"))
  .sort()) {
  await mock("/__scenario", {
    mock: { account: { balance_seconds: 360_000 }, completeState: "done" },
  });
  console.log(`== ${file}`);
  const run = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join("examples", file), ...(args[file] ?? [])],
    {
      stdio: "inherit",
      timeout: 120_000,
      env: { ...process.env, HUSHSCRIPT_BASE_URL: baseUrl, HUSHSCRIPT_TOKEN: token },
    },
  );
  if (run.status !== 0) {
    console.log(`FAILED ${file} (exit ${String(run.status)})`);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
