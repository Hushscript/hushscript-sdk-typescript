import { ConflictError, Hushscript } from "../src/index.ts";

const acceptTerms = process.argv[2];
if (acceptTerms === undefined) throw new Error("usage: agent-signup.ts <terms version>");

const signup = await Hushscript.agent.signup({
  email: "agent@example.com",
  pack: "45min",
  acceptTerms,
  agent: { name: "Example agent", platform: "custom" },
});
console.log(`pay ${signup.price.formatted} at ${signup.checkoutUrl}`);

// The claim answers wrong_state until the checkout is paid. A lost answer is never retried.
for (;;) {
  try {
    const account = await Hushscript.agent.claim(signup.signupId, signup.claimSecret);
    const hs = new Hushscript({ token: account.token });
    console.log(`claimed ${account.userId} with ${String((await hs.balance()).minutes)} minutes`);
    const rotated = await hs.agent.rotateToken();
    console.log(`rotated; scopes: ${rotated.scopes.join(", ")}`);
    break;
  } catch (error) {
    if (!(error instanceof ConflictError) || error.code !== "wrong_state") throw error;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
