import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "node_modules");
/** @type {[string, string][]} */
const versions = [
  ["@stryker-mutator/vitest-runner", "10.0.0"],
  ["vitest", "5.0.3"],
];
for (const [name, version] of versions) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(resolve(root, name, "package.json"), "utf8"));
  const pkg = /** @type {{ version: string }} */ (parsed);
  if (pkg.version !== version) throw new Error(`Expected ${name}@${version}, got ${pkg.version}`);
}

const oldName = `function collectTestName({ name, suite, }) {
    const nameParts = [name];
    let currentSuite = suite;
    while (currentSuite) {
        nameParts.unshift(currentSuite.name);
        currentSuite = currentSuite.suite;
    }
    return nameParts.join(' ').trim();
}`;
const newName = `function collectTestName({ fullTestName }) {
    if (typeof fullTestName !== 'string') {
        throw new Error('Pinned Vitest 5 fullTestName is missing');
    }
    return fullTestName;
}`;
const beforeRun = `        const dryRunResult = await this.run({`;
const guardedRun = `        if (options.testFilter?.length === 0) {
            throw new Error('Stryker Vitest selection executed zero tests: empty testFilter');
        }
${beforeRun}`;
const beforeHitCount = `        const hitCount = this.readHitCount();`;
const guardedHitCount = `        if (dryRunResult.status === DryRunStatus.Complete &&
            !dryRunResult.tests.some((test) => test.status !== TestStatus.Skipped)) {
            throw new Error('Stryker Vitest selection executed zero tests');
        }
${beforeHitCount}`;
const oldPattern = `            const regex = new RegExp(regexTestNameFilter);`;
const newPattern = `            const regex = new RegExp('^(?:' + regexTestNameFilter + ')$');`;

/** @type {[string, string, [string, string][]][]} */
const patches = [
  [
    "test-helpers.js",
    "120ef95f006b5449019155f93c049d888f2c73b525cfd57a9131ebe3d953535e",
    [[oldName, newName]],
  ],
  [
    "stryker-setup.js",
    "11ea94ed9ba49a916fb0f6cbb365e896f4ce67958009f7a4320ceebaba14febb",
    [[oldName, newName]],
  ],
  [
    "vitest-test-runner.js",
    "be9ca8376eee10364398deb9d92faed06ac77fbfa53a55482799172925789ea4",
    [
      [beforeRun, guardedRun],
      [beforeHitCount, guardedHitCount],
      [oldPattern, newPattern],
    ],
  ],
];
/** @param {string} source */
const hash = (source) => createHash("sha256").update(source).digest("hex");
const pending = patches.map(([file, expectedHash, replacements]) => {
  const path = resolve(root, "@stryker-mutator/vitest-runner/dist/src", file);
  const current = readFileSync(path, "utf8");
  let original = current;
  for (const [before, after] of replacements) original = original.replace(after, () => before);
  if (hash(original) !== expectedHash) throw new Error(`Unexpected original hash: ${file}`);
  let patched = original;
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error(`Expected one patch site: ${file}`);
    patched = patched.replace(before, () => after);
  }
  if (current !== original && current !== patched) throw new Error(`Partial patch: ${file}`);
  return { path, patched, changed: current !== patched };
});
if (pending.some(({ changed }) => changed !== pending[0]?.changed)) {
  throw new Error("Mixed patch state: expected all three files original or all three patched");
}
for (const { path, patched, changed } of pending) {
  if (changed) writeFileSync(path, patched);
}
console.log("Pinned Stryker 10.0.0 / Vitest 5.0.3 selection patch verified");
