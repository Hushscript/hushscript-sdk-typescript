import fc from "fast-check";

// Nightly CI multiplies every property's iteration count (FC_RUNS_FACTOR=10).
const factor = Number(process.env["FC_RUNS_FACTOR"] ?? "1");
fc.configureGlobal({ numRuns: 100 * (Number.isFinite(factor) && factor > 0 ? factor : 1) });
