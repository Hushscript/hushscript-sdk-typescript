import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const guard = resolve("scripts/check-mutation-score.mjs");
const source = "export const value = 1;\n";
const config = {
  mutate: ["src/http/**/*.ts", "src/transcribe/**/*.ts"],
  thresholds: { high: 90, low: 85, break: 80 },
};
/** @param {string[]} statuses */
function fixture(statuses) {
  return {
    schemaVersion: "1.0",
    config: structuredClone(config),
    thresholds: structuredClone(config.thresholds),
    testFiles: { "test/value.test.ts": { tests: [{ id: "t1", name: "value" }] } },
    files: {
      "src/http/value.ts": {
        language: "typescript",
        source,
        mutants: statuses.map((status, index) => ({
          id: String(index),
          status,
          mutatorName: "NumberLiteral",
          location: { start: { line: 1, column: 22 }, end: { line: 1, column: 23 } },
          testsCompleted: 1,
          killedBy: ["t1"],
        })),
      },
    },
  };
}
/** @param {unknown} report @param {boolean} extraSource */
function run(report, extraSource = false) {
  const root = mkdtempSync(join(tmpdir(), "mutation-score-"));
  try {
    mkdirSync(join(root, "src/http"), { recursive: true });
    mkdirSync(join(root, "src/transcribe"), { recursive: true });
    writeFileSync(join(root, "src/http/value.ts"), source);
    writeFileSync(join(root, "src/transcribe/types.ts"), "export type Value = number;\n");
    if (extraSource) writeFileSync(join(root, "src/transcribe/missing.ts"), source);
    writeFileSync(join(root, "stryker.config.json"), JSON.stringify(config));
    const path = join(root, "mutation.json");
    if (report !== undefined) writeFileSync(path, JSON.stringify(report));
    return spawnSync(process.execPath, [guard, path], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const pass = ["Killed", "Killed", "Killed", "Killed", "Survived"];
void test("exact 80 passes; compile-invalid excluded and counted; type-only scope verified", () => {
  const result = run(fixture([...pass, "CompileError"]));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"CompileError":1/);
  assert.match(result.stdout, /"denominator":5/);
  assert.match(result.stdout, /"verifiedTypeOnlySources":1/);
});
void test("timeouts and uncovered mutants stay in denominator, never kills", () => {
  for (const status of ["Timeout", "NoCoverage"]) {
    const result = run(fixture([...pass, status]));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /"Killed":4/);
    assert.match(result.stdout, /"denominator":6/);
  }
});
void test("rounded 80 and historical v3 counts fail", () => {
  const rounded = run(
    fixture([
      ...Array.from({ length: 39999 }, () => "Killed"),
      ...Array.from({ length: 10001 }, () => "Survived"),
    ]),
  );
  assert.equal(rounded.status, 1);
  assert.match(rounded.stdout, /"score":79\.998/);
  const historical = run(
    fixture([
      ...Array.from({ length: 1595 }, () => "Killed"),
      ...Array.from({ length: 74 }, () => "Timeout"),
      ...Array.from({ length: 402 }, () => "Survived"),
      ...Array.from({ length: 20 }, () => "NoCoverage"),
      ...Array.from({ length: 2 }, () => "CompileError"),
    ]),
  );
  assert.equal(historical.status, 1);
  assert.match(historical.stdout, /"denominator":2091/);
});
void test("ignored mutants need a reason and stay in the denominator, never kills", () => {
  const report = fixture([...pass, "Ignored"]);
  const mutants = report.files["src/http/value.ts"].mutants;
  Object.assign(mutants[5] ?? {}, { statusReason: "equivalent: same output" });
  const result = run(report);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"Ignored":1/);
  assert.match(result.stdout, /"denominator":6/);
  const passing = fixture([...pass, ...pass, "Killed", "Killed", "Killed", "Killed", "Ignored"]);
  Object.assign(passing.files["src/http/value.ts"].mutants[14] ?? {}, { statusReason: "why" });
  const ok = run(passing);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"denominator":15/);
  for (const reason of [undefined, "", "  ", 3]) {
    const bare = fixture([...pass, "Ignored"]);
    Object.assign(bare.files["src/http/value.ts"].mutants[5] ?? {}, { statusReason: reason });
    assert.equal(run(bare).status, 1, String(reason));
  }
});
void test("invalid, pending, unknown and missing statuses fail closed", () => {
  for (const status of ["RuntimeError", "Pending", "Unknown", ""]) {
    assert.equal(run(fixture([...pass, status])).status, 1, status);
  }
  const report = fixture(pass);
  Reflect.deleteProperty(report.files["src/http/value.ts"].mutants[0] ?? {}, "status");
  assert.equal(run(report).status, 1);
});
void test("missing, malformed, empty, all-invalid and partial reports fail closed", () => {
  for (const report of [undefined, null, {}, fixture([]), fixture(["CompileError"])]) {
    assert.equal(run(report).status, 1);
  }
  assert.equal(run(fixture(pass), true).status, 1);
  const shard = fixture(pass);
  shard.config.mutate = ["src/http/value.ts"];
  assert.equal(run(shard).status, 1);
  const stale = fixture(pass);
  stale.files["src/http/value.ts"].source = "old source";
  assert.equal(run(stale).status, 1);
  const empty = fixture(pass);
  Reflect.deleteProperty(empty.files, "src/http/value.ts");
  assert.equal(run(empty).status, 1);
});
void test("kills require completed tests and known killing IDs", () => {
  for (const completed of [0, -1, 0.5]) {
    const report = fixture(pass);
    for (const mutant of report.files["src/http/value.ts"].mutants)
      mutant.testsCompleted = completed;
    assert.equal(run(report).status, 1);
  }
  const absent = fixture(pass);
  Reflect.deleteProperty(absent.files["src/http/value.ts"].mutants[0] ?? {}, "testsCompleted");
  assert.equal(run(absent).status, 1);
  for (const killedBy of [[], ["unknown"]]) {
    const report = fixture(pass);
    for (const mutant of report.files["src/http/value.ts"].mutants) mutant.killedBy = killedBy;
    assert.equal(run(report).status, 1);
  }
});

void test("missing mutant fields and duplicate IDs fail closed", () => {
  for (const key of ["location", "mutatorName", "id", "killedBy"]) {
    const report = fixture(pass);
    Reflect.deleteProperty(report.files["src/http/value.ts"].mutants[0] ?? {}, key);
    assert.equal(run(report).status, 1, key);
  }
  const duplicate = fixture(pass);
  for (const mutant of duplicate.files["src/http/value.ts"].mutants) mutant.id = "same";
  assert.equal(run(duplicate).status, 1);
});
void test("mutation command preserves engine errors and applies the guard after success", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  const match = /engine_status=0;[\s\S]*?exit "\$\$guard_status"/.exec(compose);
  assert.ok(match);
  for (const [engine, guardStatus, expected] of [
    [23, 0, 23],
    [23, 1, 23],
    [0, 1, 1],
    [0, 0, 0],
  ]) {
    /** @type {string} */
    const command = match[0]
      .replaceAll("$$", "$")
      .replace("timeout 1800 stryker run", `sh -c 'exit ${engine}'`)
      .replace(
        "timeout 120 node scripts/check-mutation-score.mjs /mutation-report/mutation.json",
        `sh -c 'exit ${guardStatus}'`,
      );
    assert.equal(spawnSync("sh", ["-c", command]).status, expected);
  }
});

void test("unused mutation service has safe defaults for direct Compose callers", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  assert.ok(compose.includes("${HOST_UID:-10001}:${HOST_GID:-10001}"));
  assert.ok(compose.includes("${MUTATION_REPORT_DIR:-./reports/mutation}:/mutation-report"));
  assert.doesNotMatch(compose, /\$\{(?:HOST_UID|HOST_GID|MUTATION_REPORT_DIR):\?/);
  const recipes = readFileSync("justfile", "utf8");
  const mutation = recipes.slice(
    recipes.indexOf("mutation version="),
    recipes.indexOf("# the conformance suite"),
  );
  assert.ok(mutation.indexOf("mktemp -d") < mutation.indexOf("docker compose build"));
});
