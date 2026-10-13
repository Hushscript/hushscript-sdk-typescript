import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

/** @param {unknown} value @param {string} label */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} directory @returns {string[]} */
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

try {
  const reportPath = process.argv[2];
  if (!reportPath || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/check-mutation-score.mjs REPORT.json");
  }
  const config = object(JSON.parse(readFileSync("stryker.config.json", "utf8")), "config");
  const scope = ["src/http/**/*.ts", "src/transcribe/**/*.ts"];
  if (JSON.stringify(config["mutate"]) !== JSON.stringify(scope)) {
    throw new Error("Mutation source scope must remain src/http and src/transcribe in full");
  }
  if (object(config["thresholds"], "thresholds")["break"] !== 80) {
    throw new Error("Stryker breaking threshold must remain 80");
  }
  const report = object(JSON.parse(readFileSync(reportPath, "utf8")), "report");
  if (report["schemaVersion"] !== "1.0") throw new Error("Unsupported report schema");
  const reportedThresholds = object(report["thresholds"], "reported thresholds");
  if (
    reportedThresholds["high"] !== 90 ||
    reportedThresholds["low"] !== 85 ||
    reportedThresholds["break"] !== 80
  ) {
    throw new Error("Missing or changed report thresholds");
  }
  const effective = object(report["config"], "report config");
  if (
    JSON.stringify(effective["mutate"]) !== JSON.stringify(scope) ||
    object(effective["thresholds"], "report thresholds")["break"] !== 80
  ) {
    throw new Error("Partial or changed mutation configuration");
  }
  if (effective["ignoreStatic"] === true || effective["incremental"] === true) {
    throw new Error("Ignored or reused mutants cannot certify a full run");
  }
  const mutator = effective["mutator"];
  if (mutator !== undefined) {
    const excluded = object(mutator, "mutator")["excludedMutations"];
    if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length)) {
      throw new Error("Excluded mutations cannot certify a full run");
    }
  }
  const files = object(report["files"], "files");
  const expected = [...sources("src/http"), ...sources("src/transcribe")];
  const testIds = new Set();
  for (const file of Object.values(object(report["testFiles"], "testFiles"))) {
    const tests = object(file, "test file")["tests"];
    if (!Array.isArray(tests)) throw new Error("Missing test inventory");
    for (const test of tests) {
      const id = object(test, "test")["id"];
      if (typeof id !== "string" || !id || testIds.has(id)) {
        throw new Error("Invalid or duplicate test id");
      }
      testIds.add(id);
    }
  }
  if (!testIds.size) throw new Error("Empty test inventory");
  for (const path of Object.keys(files)) {
    if (!expected.includes(path)) throw new Error(`Unexpected report source: ${path}`);
  }
  const counts = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, CompileError: 0, Ignored: 0 };
  const ids = new Set();
  let typeOnly = 0;
  for (const path of expected) {
    const source = readFileSync(path, "utf8");
    // Stryker only serializes files with mutants. Verify omitted files have no executable output.
    const emitted = ts
      .transpileModule(source, {
        fileName: path,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          removeComments: true,
        },
      })
      .outputText.replace(/export\s*\{\s*\};?/g, "")
      .trim();
    if (!Object.hasOwn(files, path)) {
      if (emitted) throw new Error(`Missing configured source: ${path}`);
      typeOnly++;
      continue;
    }
    const file = object(files[path], path);
    if (file["source"] !== source || file["language"] !== "typescript") {
      throw new Error(`Stale or invalid source: ${path}`);
    }
    const mutants = file["mutants"];
    if (!Array.isArray(mutants) || (emitted && !mutants.length)) {
      throw new Error(`Empty or incomplete mutants: ${path}`);
    }
    for (const value of mutants) {
      const mutant = object(value, "mutant");
      const id = mutant["id"];
      const status = mutant["status"];
      if (typeof id !== "string" || !id || ids.has(id)) throw new Error("Invalid mutant id");
      ids.add(id);
      if (typeof mutant["mutatorName"] !== "string" || !mutant["mutatorName"]) {
        throw new Error(`Missing mutator name: ${id}`);
      }
      const location = object(mutant["location"], "mutant location");
      for (const endpoint of ["start", "end"]) {
        const point = object(location[endpoint], "location endpoint");
        for (const axis of ["line", "column"]) {
          const coordinate = point[axis];
          if (
            typeof coordinate !== "number" ||
            !Number.isSafeInteger(coordinate) ||
            coordinate < 0
          ) {
            throw new Error(`Invalid mutant location: ${id}`);
          }
        }
      }
      if (typeof status !== "string" || !Object.hasOwn(counts, status)) {
        throw new Error(`Disallowed mutant status: ${String(status)}`);
      }
      // A per-site `// Stryker disable` exclusion must say why; it is never a kill.
      if (status === "Ignored") {
        const reason = mutant["statusReason"];
        if (typeof reason !== "string" || !reason.trim()) {
          throw new Error(`Ignored mutant ${id} has no reason`);
        }
      }
      if (status === "Killed") {
        const completed = mutant["testsCompleted"];
        const killedBy = mutant["killedBy"];
        if (typeof completed !== "number" || !Number.isSafeInteger(completed) || completed < 1) {
          throw new Error(`Killed mutant ${id} has no completed-test proof`);
        }
        if (
          !Array.isArray(killedBy) ||
          !killedBy.length ||
          killedBy.some((test) => typeof test !== "string" || !testIds.has(test))
        ) {
          throw new Error(`Killed mutant ${id} has no known killing test`);
        }
      }
      counts[/** @type {keyof typeof counts} */ (status)]++;
    }
  }
  const denominator =
    counts.Killed + counts.Survived + counts.Timeout + counts.NoCoverage + counts.Ignored;
  if (!denominator) throw new Error("No valid measured mutants");
  const score = (100 * counts.Killed) / denominator;
  console.log(
    JSON.stringify({
      report: resolve(reportPath),
      configuredSources: expected.length,
      reportedSources: Object.keys(files).length,
      verifiedTypeOnlySources: typeOnly,
      ...counts,
      denominator,
      score,
      floor: 80,
    }),
  );
  if (counts.Killed * 100 < denominator * 80) {
    throw new Error(`Test-killed mutation score ${score.toFixed(6)} is below 80`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
