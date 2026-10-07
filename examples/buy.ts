// Spends money: it needs a pack id, and a yes from you, before it charges the saved card.
//   node buy.ts 300min          asks first
//   node buy.ts 300min --yes    skips the question
//   node buy.ts 300min --yes --key <key>   asks again after a failure that printed a retry key
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- stable in every Node 22 release; the rule's table lags
import { createInterface } from "node:readline/promises";
import { Hushscript, HushscriptError } from "@hushscript/sdk";

const [pack, ...flags] = process.argv.slice(2);
const keyAt = flags.indexOf("--key");
const retryKey = keyAt === -1 ? undefined : flags[keyAt + 1];

async function main(): Promise<number> {
  const hs = new Hushscript();
  const packs = await hs.billing.packs();
  for (const available of packs) {
    console.log(
      `${available.id}: ${String(available.minutes)} minutes for ${available.price.formatted}`,
    );
  }
  const chosen = packs.find((candidate) => candidate.id === pack);
  if (chosen === undefined) {
    console.log("usage: buy.ts <pack id> [--yes]. Name one of the packs above to buy it.");
    return 2;
  }

  // Show the buyer this notice before the call; acknowledgeNoRefund records that it was shown.
  console.log(
    "Minutes are added to your account instantly after payment. All purchases are final and non-refundable.",
  );
  if (!flags.includes("--yes")) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(
      `Charge your saved card ${chosen.price.formatted} for ${chosen.id}? [y/N] `,
    );
    prompt.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Nothing was bought.");
      return 1;
    }
  }

  const purchase = await hs.buy(chosen.id, {
    acknowledgeNoRefund: true,
    idempotencyKey: retryKey,
  });
  console.log(`bought ${chosen.id}; now ${String(purchase.minutes)} minutes`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof HushscriptError)) throw error;
  console.log(`${error.code}: ${error.hint ?? error.message}`);
  // The card may have been charged. Run it again with this key and it cannot charge twice.
  if (error.idempotencyKey !== null) console.log(`retry with: --key ${error.idempotencyKey}`);
  process.exitCode = 1;
}
