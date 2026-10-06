// Placeholder runner. It proves the compose wiring (mock reachable at 127.0.0.1:4010, no other
// network) by listing the scenarios and reporting every one as skipped. The real runner replaces it
// in the client task; the runner contract forbids skipping, so a skip here is scaffold-only.
const BASE_URL = "http://127.0.0.1:4010";

const response = await fetch(`${BASE_URL}/__scenarios`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`GET /__scenarios answered ${String(response.status)}`);
const body = (await response.json()) as { scenarios?: unknown };
const scenarios = Array.isArray(body.scenarios) ? body.scenarios.filter((s) => typeof s === "string") : [];
if (scenarios.length === 0) throw new Error("the mock lists no scenarios");

for (const name of scenarios) console.log(`SKIP ${name}`);
console.log(`0 passed, 0 failed, ${String(scenarios.length)} skipped`);
