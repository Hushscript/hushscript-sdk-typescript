import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** @typedef {{id: string, status: number}} TestResult */
/** @typedef {{status: string, tests: TestResult[], mutantCoverage: {perTest: Record<string, Record<string, number>>}}} DryResult */
/** @typedef {{activeMutant: {id: string}, sandboxFileName: string, testFilter?: string[], hitLimit: number, mutantActivation: string}} MutantOptions */
/** @typedef {{init(): Promise<void>, dispose(): Promise<void>, dryRun(options: object): Promise<DryResult>, mutantRun(options: MutantOptions): Promise<{status: string, nrOfTests?: number, failureMessage?: string}>, readHitCount(): number}} Runner */
const modules = resolve("node_modules");
/** @type {unknown} */
const importedRunner = await import(
  join(modules, "@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js")
);
const runnerModule =
  /** @type {{VitestTestRunner: new (options: object, log: object, namespace: string) => Runner}} */ (
    importedRunner
  );
const log = {
  isDebugEnabled: () => false,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  trace: () => undefined,
};
const originalCwd = process.cwd();
const work = mkdtempSync(join(tmpdir(), "stryker-selection-"));
const evidence = process.argv[2];

function checkPatchStates() {
  const fixture = join(work, "patch-states");
  const runnerRoot = join(fixture, "@stryker-mutator/vitest-runner");
  const dist = join(runnerRoot, "dist/src");
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(fixture, "vitest"));
  const runnerPackage = join(runnerRoot, "package.json");
  writeFileSync(runnerPackage, '{"version":"10.0.0"}');
  writeFileSync(join(fixture, "vitest/package.json"), '{"version":"5.0.5"}');
  const files = ["test-helpers.js", "stryker-setup.js", "vitest-test-runner.js"];
  const patched = files.map((file) =>
    readFileSync(join(modules, "@stryker-mutator/vitest-runner/dist/src", file), "utf8"),
  );
  const original = patched.map((source) =>
    source
      .replace(
        `function collectTestName({ fullTestName }) {
    if (typeof fullTestName !== 'string') {
        throw new Error('Pinned Vitest 5 fullTestName is missing');
    }
    return fullTestName;
}`,
        `function collectTestName({ name, suite, }) {
    const nameParts = [name];
    let currentSuite = suite;
    while (currentSuite) {
        nameParts.unshift(currentSuite.name);
        currentSuite = currentSuite.suite;
    }
    return nameParts.join(' ').trim();
}`,
      )
      .replace(
        `        if (options.testFilter?.length === 0) {
            throw new Error('Stryker Vitest selection executed zero tests: empty testFilter');
        }
`,
        "",
      )
      .replace(
        `        if (dryRunResult.status === DryRunStatus.Complete &&
            !dryRunResult.tests.some((test) => test.status !== TestStatus.Skipped)) {
            throw new Error('Stryker Vitest selection executed zero tests');
        }
`,
        "",
      )
      .replace(
        "new RegExp('^(?:' + regexTestNameFilter + ')$')",
        "new RegExp(regexTestNameFilter)",
      ),
  );
  const patchScript = resolve("scripts/patch-stryker-vitest.mjs");
  const runPatch = () => spawnSync(process.execPath, [patchScript, fixture], { encoding: "utf8" });
  /** @param {string[]} sources */
  const seed = (sources) => {
    files.forEach((file, index) => {
      const path = join(dist, file);
      const source = sources[index];
      assert.ok(typeof source === "string");
      writeFileSync(path, source);
      utimesSync(path, 1, 1);
    });
  };
  const snapshot = () =>
    files.map((file) => {
      const path = join(dist, file);
      return { bytes: readFileSync(path), mtime: statSync(path, { bigint: true }).mtimeNs };
    });
  /** @param {RegExp} message */
  const rejectWithoutWrites = (message) => {
    const before = snapshot();
    const result = runPatch();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.deepEqual(snapshot(), before);
  };
  seed(original);
  const first = runPatch();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    files.map((file) => readFileSync(join(dist, file), "utf8")),
    patched,
  );
  const beforeIdempotence = snapshot();
  const second = runPatch();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(snapshot(), beforeIdempotence);
  for (let mask = 1; mask < 7; mask++) {
    seed(
      files.map((_, index) => {
        const source = mask & (1 << index) ? patched[index] : original[index];
        assert.ok(typeof source === "string");
        return source;
      }),
    );
    rejectWithoutWrites(/Mixed patch state/);
  }
  seed(original);
  writeFileSync(runnerPackage, '{"version":"10.0.1"}');
  rejectWithoutWrites(/Expected @stryker-mutator\/vitest-runner@10\.0\.0/);
  writeFileSync(runnerPackage, '{"version":"10.0.0"}');
  writeFileSync(join(fixture, "vitest/package.json"), '{"version":"5.0.4"}');
  rejectWithoutWrites(/Expected vitest@5\.0\.5/);
  writeFileSync(join(fixture, "vitest/package.json"), '{"version":"5.0.5"}');
  seed(original.map((source, index) => (index === 2 ? `${source}\n` : source)));
  rejectWithoutWrites(/Unexpected original hash/);
  seed(
    original.map((source, index) =>
      index === 2
        ? source.replace(
            "new RegExp(regexTestNameFilter)",
            () => "new RegExp('^(?:' + regexTestNameFilter + ')$')",
          )
        : source,
    ),
  );
  rejectWithoutWrites(/Partial patch/);
  console.log(
    "PASS patch versions, hashes, partial snippets, all six mixed states, no writes, idempotence",
  );
}

/** @param {string} directory @param {(runner: Runner) => Promise<void>} check @param {boolean} related */
async function withRunner(directory, check, related = false) {
  symlinkSync(modules, join(directory, "node_modules"));
  process.chdir(directory);
  const runner = new runnerModule.VitestTestRunner(
    {
      vitest: { related, configFile: join(directory, "vitest.config.ts") },
      disableBail: false,
    },
    log,
    "__stryker__",
  );
  try {
    await runner.init();
    await check(runner);
  } finally {
    await runner.dispose();
    process.chdir(originalCwd);
  }
}

try {
  checkPatchStates();
  writeFileSync(join(work, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(work, "vitest.config.ts"),
    `export default {test:{include:['selection.test.ts'],maxWorkers:1}};`,
  );
  writeFileSync(
    join(work, "selection.test.ts"),
    `
import { describe, it, expect } from 'vitest';
function value() {
  const ns = globalThis.__stryker__;
  if (ns.activeMutant === 'selection') { ns.hitCount++; return 0; }
  if (ns.currentTestId) {
    ns.mutantCoverage ??= {static:{},perTest:{}};
    ns.mutantCoverage.perTest[ns.currentTestId] = {selection:1};
  }
  return 1;
}
it('root [.*+?^$(){}|\\\\] # literal > name', () => expect(value()).toBe(1));
describe('outer [.*]', () => describe('inner (suite)', () => {
  it.each(['a+b', 'c?d'])('case %s', () => expect(value()).toBe(1));
}));
it('prefix', () => expect(value()).toBe(1));
it('prefix suffix', () => expect(value()).toBe(1));
`,
  );
  await withRunner(work, async (runner) => {
    const dry = await runner.dryRun({
      files: [],
      testFiles: ["selection.test.ts"],
      coverageAnalysis: "perTest",
    });
    assert.equal(dry.status, "complete");
    assert.equal(dry.tests.filter((test) => test.status === 0).length, 5);
    const ids = Object.keys(dry.mutantCoverage.perTest);
    assert.equal(ids.length, 5);
    assert.deepEqual(new Set(ids), new Set(dry.tests.map((test) => test.id)));
    assert.ok(ids.some((id) => id.includes("outer [.*] > inner (suite) > case a+b")));
    for (const id of ids) {
      const result = await runner.mutantRun({
        activeMutant: { id: "selection" },
        sandboxFileName: "selection.test.ts",
        testFilter: [id],
        hitLimit: 100,
        mutantActivation: "runtime",
      });
      assert.equal(result.status, "killed");
      assert.equal(result.nrOfTests, 1);
      assert.equal(runner.readHitCount(), 1);
    }
    const options = {
      activeMutant: { id: "selection" },
      sandboxFileName: "selection.test.ts",
      hitLimit: 100,
      mutantActivation: "runtime",
    };
    await assert.rejects(
      runner.mutantRun({ ...options, testFilter: ["selection.test.ts#missing"] }),
      /executed zero tests/,
    );
    await assert.rejects(runner.mutantRun({ ...options, testFilter: [] }), /executed zero tests/);
    console.log(
      "PASS root, nested, parameterized, literal regex, exact selection, missing and empty filters",
    );
  });
  if (evidence) {
    const real = join(work, "real");
    const instrumented = readFileSync(join(evidence, "src/http/retry.ts"));
    assert.equal(
      createHash("sha256").update(instrumented).digest("hex"),
      "3170ca6ba89599b7703ba909080fa6fc8f675b598d6861fead77be71012a7b1f",
    );
    cpSync(evidence, real, { recursive: true });
    await withRunner(
      real,
      async (runner) => {
        const dry = await runner.dryRun({
          files: [join(real, "src/http/retry.ts")],
          testFiles: ["test/retry.test.ts"],
          coverageAnalysis: "perTest",
        });
        assert.equal(dry.status, "complete");
        assert.equal(dry.tests.filter((test) => test.status === 0).length, 55);
        const ids = Object.entries(dry.mutantCoverage.perTest)
          .filter(([, coverage]) => coverage["432"])
          .map(([id]) => id);
        assert.ok(ids.length > 0);
        const result = await runner.mutantRun({
          activeMutant: { id: "432" },
          sandboxFileName: join(real, "src/http/retry.ts"),
          testFilter: ids,
          hitLimit: 100000,
          mutantActivation: "runtime",
        });
        assert.equal(result.status, "killed");
        assert.ok((result.nrOfTests ?? 0) > 0);
        assert.ok(runner.readHitCount() > 0);
        assert.match(result.failureMessage ?? "", /expected undefined to be 500/);
        console.log(
          "PASS actual instrumented mutant 432",
          JSON.stringify({ ...result, hitCount: runner.readHitCount(), coveredTests: ids.length }),
        );
      },
      true,
    );
  }
  // Vitest sets exitCode for the intentional assertion failures that killed the mutants.
  process.exitCode = 0;
} finally {
  process.chdir(originalCwd);
  rmSync(work, { recursive: true, force: true });
}
