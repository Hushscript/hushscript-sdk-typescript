// Nightly production smoke. Placeholder until the client exists: it reads the account over the raw
// API and asserts the balance is a number. The client task swaps this for `await hs.balance()`.
const baseUrl = process.env["HUSHSCRIPT_BASE_URL"] ?? "https://api.hushscript.com";
const token = process.env["HUSHSCRIPT_TOKEN"];
if (token === undefined || token === "") throw new Error("HUSHSCRIPT_TOKEN is not set");

const response = await fetch(`${baseUrl}/v1/account`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`GET /v1/account answered ${String(response.status)}`);
const account = (await response.json()) as { balance_seconds?: unknown };
if (typeof account.balance_seconds !== "number") throw new Error("balance_seconds is not a number");
console.log(`smoke ok: balance ${String(account.balance_seconds)} s`);
