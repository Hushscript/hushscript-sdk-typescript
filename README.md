# @hushscript/sdk

The official TypeScript SDK for the [Hushscript](https://hushscript.com) transcription API. It
uploads a file, waits for the transcript and hands it back, and it handles the failures in between
so you do not have to.

## Quick start

```sh
npm install @hushscript/sdk
export HUSHSCRIPT_TOKEN=hsr1:...   # Account → Connected apps in the Hushscript app
```

```ts
import { writeFile } from "node:fs/promises";
import { Hushscript } from "@hushscript/sdk";

const hs = new Hushscript(); // reads HUSHSCRIPT_TOKEN
const transcript = await hs.transcribe("meeting.mp3");
console.log(transcript.text);
await writeFile("meeting.srt", transcript.toSRT());
```

## Check my balance

```ts
const balance = await hs.balance();
console.log(`${balance.minutes} minutes to spend`);
```

`balance.minutes` is what you can spend now. Minutes held for jobs that are still running are
already taken out of it, so do not subtract `heldSeconds` again.

## List my transcripts

```ts
for await (const transcript of hs.transcripts.list()) {
  console.log(transcript.id, transcript.title);
}
```

The list holds finished transcripts only. A recording that is still processing is a job, so look for
it in `hs.jobs.list({ active: true })`. `hs.jobs.wait(id)` waits for one, and `hs.transcripts.get(id)`
returns the full `Transcript` once it is done.

## Buy a pack

```ts
for (const pack of await hs.billing.packs()) {
  console.log(pack.id, `${pack.minutes} minutes`, pack.price.formatted);
}
const balance = await hs.buy("300min", { acknowledgeNoRefund: true });
```

The packs are `45min`, `300min`, `900min`, `1800min` and `6000min`. Prices depend on your country,
so read them from `pack.price` and never hard-code one.

`buy()` charges your saved default card, or the only card that can be charged when there is no
default. With no usable card it raises `PaymentMethodRequiredError` and sends nothing; add one at
the URL from `hs.billing.addCardUrl()` or in the app. Show your buyer this notice before you call
it, then pass `acknowledgeNoRefund: true`:

> Minutes are added to your account instantly after payment. All purchases are final and
> non-refundable.

The flag records that the notice was shown. It does not gate the charge, and without it `buy()`
still goes ahead.

Buying from code is off until you allow it. Create a token with the `billing` permission, then turn
on "Let connected apps buy minutes" in the app under Account → Connected apps. If either is missing
the call fails with `pat_scope_missing`. If the card is declined or the bank wants to confirm the
payment, the call fails with `pat_purchase_requires_app`; buy that pack in the app.

A purchase is retried at most once, with the same idempotency key, so a flaky network never charges
you twice. Pass `idempotencyKey` to keep your own.

## Export subtitles

```ts
import { writeFile } from "node:fs/promises";

await writeFile("meeting.srt", transcript.toSRT());
await writeFile("meeting.vtt", transcript.toVTT({ language: "es" }));
await writeFile("meeting.txt", transcript.toText({ timestamps: true }));
```

The output is byte for byte what the Hushscript app exports. `toSRT` and `toVTT` wrap lines into
caption cues by default; pass `captions: false` for one cue per utterance.

## Agents: sign up without a human account

An agent can open an account, have it paid for at a hosted checkout page, and claim its own token.
None of these calls needs a token yet, so they are static.

```ts
const signup = await Hushscript.agent.signup({
  email: "agent@example.com",
  pack: "45min",
  acceptTerms: "<the policy version you accept>",
  agent: { name: "My agent", platform: "custom" },
});
console.log(`Pay ${signup.price.formatted} at ${signup.checkoutUrl}`);

// After the checkout is paid:
const account = await Hushscript.agent.claim(signup.signupId, signup.claimSecret);
const hs = new Hushscript({ token: account.token });
const next = await hs.agent.rotateToken(); // the client now uses `next.token`
```

- `acceptTerms` is never filled in for you. A wrong version fails with `policy_version_stale`, and
  the error's `hint` names the current one.
- The claim answers `wrong_state` until the checkout is paid.
- New agent accounts can buy only `45min` and `300min` until earlier purchases settle.
- Keep `claimSecret` and every token: the server shows each of them once. A claim or a rotation
  whose answer is lost raises `OutcomeUnknownError` and is never retried, because a retry could not
  succeed; its `hint` says what to check.
- `dryRun: true` validates a signup without opening a checkout.

## Errors

Every error the SDK raises extends `HushscriptError`, so one `catch` covers everything:

```ts
import { HushscriptError, InsufficientBalanceError } from "@hushscript/sdk";

try {
  await hs.transcribe("meeting.mp3");
} catch (error) {
  if (error instanceof InsufficientBalanceError) console.log(error.hint);
  else if (error instanceof HushscriptError) console.log(error.code, error.hint ?? error.message);
  else throw error;
}
```

An error carries `code` (a slug such as `insufficient_balance`), `numericCode`, `status`, `message`,
`hint` (what to do next, or `null`), `details` and `retryAfter`. The classes:

```
HushscriptError
├─ ConfigurationError
├─ PreflightError                  no credit was held
│  ├─ UnsupportedMediaError
│  ├─ FileLimitError
│  ├─ DailyLimitError
│  └─ ResumeMismatchError
├─ ApiError                        has status
│  ├─ AuthenticationError          401
│  ├─ PermissionDeniedError        403
│  ├─ InsufficientBalanceError     402
│  ├─ NotFoundError                404
│  ├─ ConflictError                409
│  ├─ ValidationError              400, 422
│  └─ RateLimitError               429
├─ PaymentMethodRequiredError
├─ UploadError
├─ JobFailedError
├─ WaitTimeoutError                has resumeToken
├─ AbortError                      has resumeToken once a job exists
├─ NetworkError
└─ OutcomeUnknownError
```

An error raised after an upload started carries `idempotencyKey` and, once the job exists,
`resumeToken`. Pass the token to `hs.resume(token, file)` to carry on without a second charge.

## What the SDK does for you

- **Checks before it spends.** It sniffs the format from the file's bytes, probes the duration,
  and refuses a file the server would refuse, or one your balance or daily limit cannot cover,
  before any minutes are held.
- **Never charges twice.** Every upload and purchase carries an idempotency key. Retries reuse it,
  and a `resumeToken` replays the same job instead of starting a new one.
- **Retries what is safe.** Reads, heartbeats and part uploads retry on network errors, 429 and 5xx
  with jittered backoff, and honor `Retry-After` up to 60 seconds. A purchase retries once on a
  network error, 502 or 503. A claim, a rotation and a signup never retry.
- **Paces uploads.** The API allows four upload creates a minute. A loop over a folder waits as
  needed, and `onProgress` keeps reporting.
- **Keeps the upload alive.** It uploads parts in parallel with bounded memory, falls back to the
  proxied route when direct upload fails, refreshes expired part URLs and sends a heartbeat every two
  minutes.
- **Waits and fetches.** It polls the job until it is done, raises `JobFailedError` if it fails,
  and gives you a `resumeToken` if the wait times out. The job keeps running.
- **Redacts the token** from every error, log line and `toString`.

## Supported formats

MP3, M4A, MP4 and MOV (the audio track of a video is used), WAV, FLAC, and OGG with Vorbis or Opus.
Files can be up to 5 GB and from 15 seconds to 10 hours. The SDK does not convert media. For
anything else, convert it first:

```sh
ffmpeg -i input -vn -c:a libopus output.opus
```

## Privacy

The SDK sends no telemetry. The only client identification is the `User-Agent` header
(`hushscript-typescript/<version> <runtime>/<version>`). Logging is off by default;
`HUSHSCRIPT_LOG=debug` (or `logLevel: "debug"`) writes one line per request with the method, path,
status and timing, and never a header, body, title or transcript text.

## The low-level API

Every `/v1` operation is available as `hs.api`, typed from the OpenAPI document and sent through
the same retries, timeouts and redaction:

```ts
const { data } = await hs.api.GET("/v1/account");
```

The generated `paths`, `components` and `operations` types are exported too.

## Server only

The SDK is for servers. The API does not accept browser origins, and a token in a browser bundle is
a leaked token, so constructing a client where `window` and `document` exist throws
`ConfigurationError`.

## Pricing

Hushscript sells prepaid minute packs, with no subscription. The price of a pack depends on your
country, and your minutes stay valid for a year after your last transcription or purchase. A
transcription uses the minutes of the recording; medical mode and each translation target use more.
Current prices are on [hushscript.com/pricing](https://hushscript.com/pricing).

## Requirements

Node 22 or newer, Bun 1.2 or newer, or Deno 2 or newer. The SDK is for server runtimes only: a token
in a browser bundle is a leaked token.

The package is ESM-first: `import { ... } from "@hushscript/sdk"`. On Node 22.12 and newer,
`require("@hushscript/sdk")` also works, because Node can `require()` an ES module (the `default`
export condition points at the same ESM build). TypeScript consumers need TypeScript 5.5 or newer;
`just build` type-checks the packed declarations with exactly 5.5 in a container.

## Releases

Releases come from release-please. The package is published to npm by `publish.yml` through npm
trusted publishing (OIDC): no npm token is stored in GitHub. The very first publish of
`@hushscript/sdk` cannot use a trusted publisher, because the package does not exist on the registry
yet, so the owner publishes it once by hand (workspace plan, Task 19) and then attaches the trusted
publisher (this repository, workflow `publish.yml`, environment `release`) in the package settings on
npmjs.com. Every later release is published by the workflow with provenance.

## Development

Everything runs in containers; nothing touches a host toolchain. You need Docker with Compose v2 and
[just](https://github.com/casey/just).

```sh
just ci                 # lint, then test and conformance on Node 22 and 24, then examples and build
just test 24            # unit tests with coverage on one runtime
just lint               # every static check
just regen              # regenerate openapi.json and src/generated from the production spec
```

The conformance mock is built from the `hushscript-sdk-conformance` repository at the tag pinned in
`compose.yaml`. To use a local checkout instead:

```sh
CONFORMANCE_CONTEXT=../hushscript-sdk-conformance CONFORMANCE_DIR=../hushscript-sdk-conformance just ci
```

`docs/repo-template.md` describes how this repository is put together and how the sibling SDK
repositories reuse it.

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT
