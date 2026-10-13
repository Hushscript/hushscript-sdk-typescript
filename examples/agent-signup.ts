// Signs an agent account up, waits for the checkout to be paid, claims the token and rotates it.
// The server shows each token once, so every one is written to <token file> (mode 0600) the
// moment it arrives, before anything else can fail.
//   node agent-signup.ts <terms version> <token file>
import { open } from "node:fs/promises";
import { ConflictError, Hushscript, HushscriptError, type AgentClaim } from "@hushscript/sdk";

const [acceptTerms, tokenFile] = process.argv.slice(2);
if (acceptTerms === undefined || tokenFile === undefined) {
  throw new Error("usage: agent-signup.ts <terms version> <token file>");
}

const keep = async (token: string): Promise<void> => {
  // The mode only applies when the file is created, so tighten it before the token goes in.
  const file = await open(tokenFile, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${token}\n`);
  } finally {
    await file.close();
  }
};

try {
  const signup = await Hushscript.agent.signup({
    email: "agent@example.com",
    pack: "45min",
    acceptTerms,
    agent: { name: "Example agent", platform: "custom" },
  });
  console.log(`pay ${signup.price.formatted} at ${signup.checkoutUrl}`);

  // The claim answers wrong_state until the checkout is paid. A lost answer is never retried.
  let account: AgentClaim | null = null;
  while (account === null) {
    try {
      account = await Hushscript.agent.claim(signup.signupId, signup.claimSecret);
    } catch (error) {
      if (!(error instanceof ConflictError) || error.code !== "wrong_state") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await keep(account.token);
  console.log(`claimed ${account.userId}; token saved to ${tokenFile}`);

  const hs = new Hushscript({ token: account.token });
  console.log(`${String((await hs.balance()).minutes)} minutes`);
  const rotated = await hs.agent.rotateToken();
  await keep(rotated.token);
  console.log(`rotated; scopes: ${rotated.scopes.join(", ")}; new token saved to ${tokenFile}`);
} catch (error) {
  if (!(error instanceof HushscriptError)) throw error;
  console.log(`${error.code}: ${error.hint ?? error.message}`);
  console.log(`Any token that was issued is in ${tokenFile}.`);
  process.exitCode = 1;
}
