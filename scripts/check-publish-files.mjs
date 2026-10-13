// Reads the JSON of `npm pack --dry-run --json` (the file list `npm publish` uploads) and fails
// unless the tarball holds exactly dist/index.js, dist/index.d.ts, README.md, LICENSE and package.json.
import { readFileSync } from "node:fs";

const [, , file] = process.argv;
if (file === undefined) throw new Error("usage: check-publish-files.mjs <pack.json>");
const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(file, "utf8")));
/** @typedef {{ name: string, version: string, files: { path: string }[] }} PackReport */
const first = Array.isArray(parsed) ? /** @type {unknown} */ (parsed[0]) : parsed;
const report = /** @type {PackReport} */ (first);
const paths = report.files.map((entry) => entry.path).sort();
console.log(`${report.name}@${report.version}`);
for (const path of paths) console.log(`  ${path}`);

const expected = ["LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "package.json"];
const unexpected = paths.filter((path) => !expected.includes(path));
const missing = expected.filter((path) => !paths.includes(path));
if (unexpected.length > 0 || missing.length > 0) {
  console.error(
    `unexpected files: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
  );
  process.exitCode = 1;
}
