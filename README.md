# @hushscript/sdk

The official TypeScript SDK for the [Hushscript](https://hushscript.com) transcription API. It
uploads a file, waits for the transcript and hands it back, and it handles the failures in between
so you do not have to.

## Quick start

```sh
npm install @hushscript/sdk
export HUSHSCRIPT_TOKEN=hsr1:...   # Account → MCP in the Hushscript app
```

```ts
import { writeFile } from "node:fs/promises";
import { Hushscript } from "@hushscript/sdk";

const hs = new Hushscript(); // reads HUSHSCRIPT_TOKEN
const transcript = await hs.transcribe("meeting.mp3");
console.log(transcript.text);
await writeFile("meeting.srt", transcript.toSRT());
```

## Inputs

`transcribe()` and `resume()` take a path, a `Blob`, a `Uint8Array` or a `ReadableStream<Uint8Array>`.
A stream is read once, in order, one part at a time, so it needs its exact `size` and `durationSeconds`:

```ts
const response = await fetch(url);
const transcript = await hs.transcribe(response.body!, {
  size: Number(response.headers.get("content-length")),
  durationSeconds: 1800,
});
```

The stream stays yours: the SDK never cancels or closes it, on success, failure or abort. It only
releases its reader, so you can read what is left or cancel it yourself.

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
returns the full `Transcript` once it is done. `hs.transcripts.page({ cursor })` fetches one page; a
page whose `next_cursor` is the cursor you sent raises `pagination_loop`. The iterator yields that page's
items first, then raises `pagination_loop`.

## Buy a pack

```ts
for (const pack of await hs.billing.packs()) {
  console.log(pack.id, `${pack.minutes} minutes`, pack.price.formatted);
}
const purchase = await hs.buy("300min", { acknowledgeNoRefund: true });
console.log(`${purchase.minutes} minutes to spend now`);
```

The packs are `45min`, `300min`, `900min`, `1800min` and `6000min`. Prices depend on your country,
so read them from `pack.price` and never hard-code one.

`buy()` charges your saved default card, or the only card that can be charged when there is no
default, and returns a `Purchase`: the `seconds` and `minutes` you have after it settled. It makes
no request after the charge, so nothing can fail once the money has moved. With no usable card it
raises `PaymentMethodRequiredError` and sends nothing: `no_default_card` when there is none (add one
at the URL from `hs.billing.addCardUrl()` or in the app), `default_card_required` when several
cards could be charged and none is the default (pick one with `hs.billing.setDefaultCard(id)`).

Show your buyer this notice before you call it, then pass `acknowledgeNoRefund: true`:

> Minutes are added to your account instantly after payment. All purchases are final and
> non-refundable.

The flag records that the notice was shown. It does not gate the charge, and without it `buy()`
still goes ahead.

### Allow buying first

Buying from code is off until you allow it in three places. If any is missing, the call fails with
`pat_scope_missing`.

1. The token has the permission labeled "Buy minutes and manage your saved payment methods" (the
   `billing` scope), ticked when you create it.
2. The token has "Let this token buy minutes" turned on, on the same "Create a new token" form.
3. "Let connected apps buy minutes" is on for the whole account.

All of it is in the app under Account → MCP.

### When a purchase does not go through

If the card is declined or cannot be charged without you, the call fails with
`pat_purchase_requires_app` (403); if the bank wants to confirm the payment, it fails with
`pat_purchase_requires_authentication` (403). In both cases nothing was charged: buy that pack in
the app.

A purchase is retried at most once, on a network error, a 502 or a 503, with the same idempotency
key, so those retries cannot charge you twice. When `buy()` still gives up after the request was
sent (the connection dropped twice, or the answer was not one the SDK can use), the card may have
been charged. A 401, 429, or any 403 other than the two refusals above counts too: after the retry
it can follow a first attempt that did charge. Every such error
carries `idempotencyKey`; ask again with it and the purchase can never happen twice:

```ts
import { HushscriptError, type Purchase } from "@hushscript/sdk";

let purchase: Purchase;
try {
  purchase = await hs.buy("300min", { acknowledgeNoRefund: true });
} catch (error) {
  if (!(error instanceof HushscriptError) || error.idempotencyKey === null) throw error;
  // Only these refusals charged nothing. A 401, 429, or any 403 except 4021/4023 can follow a charged
  // first attempt (the server answers them before replaying a purchase), so retry like a lost answer.
  const refused =
    error.code !== "bad_response" &&
    ((error.status !== null && [400, 402, 404, 422].includes(error.status)) ||
      (error.status === 403 && (error.numericCode === 4021 || error.numericCode === 4023)));
  if (refused) {
    throw error;
  }
  purchase = await hs.buy("300min", {
    acknowledgeNoRefund: true,
    idempotencyKey: error.idempotencyKey,
  });
}
```

A key you pass yourself must be 1 to 128 characters from `A-Za-z0-9_-`. Do not reuse a key for a
different pack.

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
import { open } from "node:fs/promises";

// The server shows each token once, so write every one down the moment it arrives.
const keep = async (token: string): Promise<void> => {
  // The mode only applies when the file is created, so tighten it before the token goes in.
  const file = await open("agent-token", "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${token}\n`);
  } finally {
    await file.close();
  }
};

const signup = await Hushscript.agent.signup({
  email: "agent@example.com",
  pack: "45min",
  acceptTerms: "<the policy version you accept>",
  agent: { name: "My agent", platform: "custom" },
});
console.log(`Pay ${signup.price.formatted} at ${signup.checkoutUrl}`);

// After the checkout is paid:
const account = await Hushscript.agent.claim(signup.signupId, signup.claimSecret);
await keep(account.token); // before anything else can fail
const hs = new Hushscript({ token: account.token });
const next = await hs.agent.rotateToken(); // revokes the claimed token; the client uses `next.token`
await keep(next.token);
```

- `acceptTerms` is never filled in for you. A wrong version fails with `policy_version_stale`, and
  the error's `hint` names the current one.
- The claim answers `wrong_state` (a `ConflictError`) until the checkout is paid.
- New agent accounts can buy only `45min` and `300min` until earlier purchases settle.
- Keep `claimSecret` and every token: the server shows each of them once, and a rotation revokes
  the token it replaces, so lose the new one and the account is out of reach. A claim or a rotation
  whose answer is lost, or comes back without a token, raises `OutcomeUnknownError` and is never
  retried, because a retry could not succeed; its `hint` says what to check.
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

A `NetworkError` and an `OutcomeUnknownError` that wrap a failed request name the original error in
their message, for example `(TypeError: fetch failed; code ECONNREFUSED)`, with secrets redacted; the
original is the `cause`. Only a `TypeError` (what `fetch` throws for a failed connection or body) is a
network failure. Any other value `fetch` throws (a `RangeError`, a string, an error of your own
class) raises `HushscriptError` with code `unexpected_error`, is not retried, and its message names
the type, for example `The SDK failed unexpectedly after the request was sent (RangeError: ...)`;
after a claim or rotation went out it is an `OutcomeUnknownError`. The message says "before" or
"after the request was sent" only where the SDK knows, and nothing about it where it does not.

An error raised after an upload started, or after a purchase was sent, carries `idempotencyKey`;
once the job exists it carries `resumeToken` too. Pass the token to `hs.resume(token, file)` to carry on without a second charge.

## What the SDK does for you

- **Checks before it spends.** It sniffs the format from the file's bytes, probes the duration,
  and refuses a file the server would refuse, or one your daily limit cannot cover, before any
  minutes are held. Whether your balance covers the file is the server's call: a 402 comes back
  when the upload is created, before any part is sent.
- **Keeps retries from charging twice.** Every upload and purchase carries an idempotency key, and
  retries reuse it. A `resumeToken` replays the same job instead of starting a new one, and the key
  on a failed purchase does the same for `buy()`.
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
- **Redacts the token and the claim secret** from every error, log line and `toString`, and the query
  string of any URL in an error message, hint or cause (`https://host/path?[redacted]`, so a presigned
  URL's signature never prints while the host and path still say what failed). The results that hand you a
  secret (`AgentSignup.claimSecret`, `AgentClaim.token`, `RotatedToken.token`) keep it readable as a
  field, but `console.log`, `util.inspect`, `String()` and template strings show `[redacted]` in its
  place; `JSON.stringify` is your own export and carries the value.

## Supported formats

MP3, M4A, MP4 and MOV (the audio track of a video is used), WAV, FLAC, and OGG with Vorbis or Opus.
Files can be up to 5 GB and from 15 seconds to 10 hours. The SDK does not convert media. For
anything else, convert it first:

```sh
ffmpeg -i input -vn -c:a libopus output.opus
```

## Configuration

| Option                    | Env var               | Default                                                              |
| ------------------------- | --------------------- | -------------------------------------------------------------------- |
| `token`                   | `HUSHSCRIPT_TOKEN`    | none                                                                 |
| `baseUrl`                 | `HUSHSCRIPT_BASE_URL` | `https://api.hushscript.com`                                         |
| `timeout`                 | none                  | 60 s per request, at most 3600                                       |
| `maxRetries`              | none                  | 3                                                                    |
| `logLevel`                | `HUSHSCRIPT_LOG`      | `off` (`debug` logs one metadata line per request to standard error) |
| `clock`                   | none                  | the system clock; pass a `Clock` in tests                            |
| `dangerouslyAllowBrowser` | none                  | `false`; for tests only                                              |

An explicit option beats its environment variable. A `null`, empty or whitespace-only option or
variable counts as not set: the SDK falls back to the environment variable, then to the default (a
token has no default, so it raises the missing-token `ConfigurationError`). The base URL must be `https://`, or `http://` to
`localhost`, `127.0.0.1` or `[::1]`, with no path. Each upload part has its own 300 s timeout, which you cannot
change.

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

Personal accounts buy prepaid minute packs. The price of a pack depends on your
country, and your minutes stay valid for a year after your last transcription or purchase. A
transcription uses the minutes of the recording; medical mode and each translation target use more.
Current prices are on [hushscript.com/pricing](https://hushscript.com/pricing).

## Requirements

Node 22 or newer; CI tests Node 22 and 24. Bun 1.2+ and Deno 2+ are checked only for importing the
package: their HTTP behavior, including what their `fetch` does when an HTTP/2 stream is reset, is
not tested. The SDK is for server runtimes only: a token in a browser bundle is a leaked token.

The package is ESM-first: `import { ... } from "@hushscript/sdk"`. On Node 22.12 and newer,
`require("@hushscript/sdk")` also works, because Node can `require()` an ES module (the `default`
export condition points at the same ESM build). TypeScript consumers need TypeScript 5.5 or newer;
`just build` type-checks the packed declarations with exactly 5.5 in a container.

## Releases

Releases come from release-please. The package is published to npm by `publish.yml` through npm
trusted publishing (OIDC): no npm token is stored in GitHub. The very first publish of
`@hushscript/sdk` cannot use a trusted publisher, because the package does not exist on the registry
yet, so the maintainers publish it once by hand and then attach the trusted publisher (this
repository, workflow `publish.yml`, environment `release`) in the package settings on npmjs.com. Every later release is published by the workflow with provenance.

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
`package.json` (`config.conformanceRef`). To use a local checkout instead:

```sh
CONFORMANCE_CONTEXT=../hushscript-sdk-conformance CONFORMANCE_DIR=../hushscript-sdk-conformance just ci
```

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT
