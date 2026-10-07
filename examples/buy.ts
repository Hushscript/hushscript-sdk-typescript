import { Hushscript, HushscriptError } from "../src/index.ts";

const hs = new Hushscript();
for (const pack of await hs.billing.packs()) {
  console.log(`${pack.id}: ${String(pack.minutes)} minutes for ${pack.price.formatted}`);
}

// Minutes are added instantly after payment. All purchases are final and non-refundable.
try {
  const balance = await hs.buy(process.argv[2] ?? "300min", { acknowledgeNoRefund: true });
  console.log(`now ${String(balance.minutes)} minutes`);
} catch (error) {
  if (!(error instanceof HushscriptError)) throw error;
  console.log(`${error.code}: ${error.hint ?? error.message}`);
  process.exitCode = 1;
}
