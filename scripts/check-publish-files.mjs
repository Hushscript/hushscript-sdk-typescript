// Reads the JSON of `npm pack --dry-run --json` (the file list `npm publish` uploads) and fails
// unless the tarball holds only dist/, README.md, LICENSE and package.json (all four present).
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

const required = ["LICENSE", "README.md", "package.json"];
const unexpected = paths.filter((path) => !path.startsWith("dist/") && !required.includes(path));
const missing = required.filter((path) => !paths.includes(path));
if (!paths.some((path) => path.startsWith("dist/"))) missing.push("dist/");
if (unexpected.length > 0 || missing.length > 0) {
  console.error(
    `unexpected files: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
  );
  process.exitCode = 1;
}
