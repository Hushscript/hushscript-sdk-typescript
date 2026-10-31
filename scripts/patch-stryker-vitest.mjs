import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "node_modules");
/** @type {[string, string][]} */
const versions = [
  ["@stryker-mutator/vitest-runner", "10.1.1"],
  ["vitest", "5.0.5"],
];
for (const [name, version] of versions) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(resolve(root, name, "package.json"), "utf8"));
  const pkg = /** @type {{ version: string }} */ (parsed);
  if (pkg.version !== version) throw new Error(`Expected ${name}@${version}, got ${pkg.version}`);
}

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
const oldPattern = "            const regex = new RegExp(`(?:${regexTestNameFilter})\\\\s*$`);";
const newPattern = "            const regex = new RegExp(`^(?:${regexTestNameFilter})\\\\s*$`);";

/** @type {[string, string, [string, string][]][]} */
const patches = [
  [
    "vitest-test-runner.js",
    "2fbe77b4380075f86284e6e6f745a3549f336e8af83b52e1e70fa1fedd7c7cf5",
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
for (const { path, patched, changed } of pending) {
  if (changed) writeFileSync(path, patched);
}
console.log("Pinned Stryker 10.1.1 / Vitest 5.0.5 selection patch verified");
