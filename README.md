# Dust Wave Stream

An open-source film player for filmmakers who keep their originals in their own storage. Each test filmmaker connects a private Cloudflare R2 object, offers a ten-second preview, and chooses prices for a 48-hour rental, a one-time purchase, or both. Viewers pay and watch in the filmmaker’s embed. A purchase also includes the original MP4. The setup and viewer services bind to loopback and can sit behind HTTPS. Stream reads the original from the filmmaker’s bucket and creates each playable segment on demand.

## Guided filmmaker setup

Start Stream with `npm start` and give each pilot filmmaker their own sign-in link. In a second terminal, run:

```sh
npm run invite -- "Filmmaker name"
```

The filmmaker opens the link and selects **Open filmmaker setup**. It expires after 30 minutes and can be used once. Their signed-in session lasts 14 days. For a returning filmmaker, issue another invite with the same unique name to reopen their workspace. The operator can use a private handoff to share the invitation. The default local link works on the Mac running Stream.

1. **Get paid with Stripe.** To create a connected account, select your business country in Stream, then continue to Stripe for identity and payout details. You can sign in to Stripe to reuse eligible business details. If Dust Wave offers **Connect my Stripe account**, select an eligible existing Standard business directly on Stripe. Return to Stream to see what is ready or needs attention. Both payment and payout capabilities must be active. You can proceed with storage while Stripe reviews your information.
2. **Store your film on Cloudflare.** Sign in or create a Cloudflare account. Activate R2 if prompted, select or create a dedicated private bucket, and follow the card to create a bucket-scoped **Object Read only** credential. The card checks access with a signed bucket HEAD that also works on an empty bucket. The filmmaker confirms the token scope and the bucket’s public-access settings in Cloudflare. A successful read alone cannot establish either setting. You can replace a credential and retry a failed connection.
3. **Add a film.** Confirm the rights statement for this film to unlock the upload guide. Upload the file under **Objects** in your own Cloudflare dashboard or choose a file already there. Copy its exact object key, including folders. Enter a title, then choose **Check film and create preview**. Stream checks the original using conditional range reads, validates the supported MP4 format, and renders the opening ten seconds. **Watch private preview** opens the result. Each new film has its own rights confirmation and private preview. **Save draft** remembers an unfinished title and object key.

A filmmaker can set the rental and purchase prices for a film in setup. Leaving a price blank removes that offer from new checkouts. Existing saved films start with their previous $0.99 rental. New films stay private to their filmmaker during setup. The existing public demo players and sandbox purchase rehearsal are described below.

### Operator configuration

Stream runs as one Node server bound to loopback. For a hosted pilot, terminate TLS ahead of the server, forward the original Host, and set `STREAM_PUBLIC_ORIGIN` to the exact HTTPS origin in both the service and invite CLI. Keep query strings, invitation links, form bodies and credentials out of proxy logs. Do not forward payment callbacks to the demo rental CLI.

| Setting | Purpose |
| --- | --- |
| `STREAM_STATE_DIR` | Private state directory, outside the checkout and cloud sync. The `filmmakers/` subdirectory holds SQLite and its owner-only credential encryption key. Back up both privately. Run one filmmaker setup service and one viewer service per state directory on the same host. |
| `STRIPE_CONNECT_SECRET_KEY` | Dust Wave’s server-side Connect platform key. Use a sandbox key for rehearsal. Filmmakers enter identity and bank information on Stripe. |
| `STRIPE_CONNECT_CLIENT_ID` | Optional, mode-matching Standard OAuth client ID. Enable eligible existing-account connections in the Connect platform and register the exact `/setup/stripe/oauth` redirect on your origin. |
| `STRIPE_CONNECT_LIVE` | Test mode is the default. Live onboarding requires an explicit value of `1`, a matching live platform key and an HTTPS origin. Test and live connections are stored independently. |

Configure the platform for Accounts v2 merchant onboarding with a full Stripe Dashboard, direct charges and Stripe-managed fees and losses. Set Connect branding, enable networked onboarding to reuse eligible details, and configure collection of external payout details. The card stays available for explanation when the operator has not configured Connect. Storage and private previews work independently. [Stripe-hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding?accounts-namespace=v2) · [Networked onboarding](https://docs.stripe.com/connect/networked-onboarding) · [Existing Standard accounts](https://docs.stripe.com/connect/oauth-standard-accounts)

The setup cards come from Admin Shell **0.16.0** in the pinned Dust Wave Platform submodule. Stream owns the filmmaker sessions, rights records, provider calls and media checks. To run the form rehearsal, install Chromium with `npx playwright install chromium` and run `npm run check:setup`. This browser rehearsal uses simulated provider responses, real forms and the private preview renderer. The sandbox sale commands below contact Stripe and create test payments. [Cloudflare R2 credentials](https://developers.cloudflare.com/r2/api/tokens/) · [Cloudflare uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)

## Public viewer checkout in a Stripe sandbox

Finish setup for each participating filmmaker, save their film, and select **Check Stripe status**. The card must show that both charges and payouts are enabled. An operator publishes individual saved films by listing their setup owner and film ID in the viewer service’s private environment. An empty list publishes zero films.

```dotenv
STREAM_PUBLIC_FILMS='[{"owner":"Example filmmaker","id":"f-00000000-0000-4000-8000-000000000001"}]'
```

Run `npm run viewers` with the same `STREAM_STATE_DIR` as setup, the Store sandbox’s matching `STRIPE_CONNECT_SECRET_KEY` and `STRIPE_CONNECT_PUBLISHABLE_KEY`, and a 32-byte base64url `STREAM_RENTAL_SECRET` (or the state directory’s existing `rental.env`). Set `STRIPE_CONNECT_WEBHOOK_SECRET` to the signing secret for this listener. For a local rehearsal, run the following from a Stripe CLI session authenticated to the same sandbox and keep the listener running.

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed \
  --forward-connect-to http://127.0.0.1:8793/checkout/webhook
```

Open `http://127.0.0.1:8793/screening`. To share it over HTTPS, set `STREAM_PUBLIC_ORIGIN` to the exact viewer origin, forward the original Host header, and forward Connect events to that origin’s `/checkout/webhook`. The viewer service exposes only explicitly published films and viewer routes. For a registered Stripe webhook destination, choose events on **Connected accounts** and use that destination’s own signing secret. [Stripe Connect webhooks](https://docs.stripe.com/connect/webhooks)

Embed a published film on another site with its viewer URL. Give it enough space for the payment form. Use HTTPS for the publisher and the player.

```html
<iframe src="https://stream.example.org/embed/f-00000000-0000-4000-8000-000000000001"
  title="Film title" width="640" height="570" allow="autoplay; fullscreen; payment" allowfullscreen></iframe>
```

After the preview, select an available offer and pay by card in that player. Stripe Checkout collects card details inside the embed. Stream submits a direct charge to the filmmaker’s connected account and verifies payment server-side. The player starts the film when payment clears, with a play control if the browser requires a tap. Other embeds keep their own checkout and playback state. Rentals run for 48 hours from purchase. A buyer can stream the film, download the original MP4, and save a private access link to return later. Anyone holding the private link can use it. Keep it out of shared embeds. [Stripe direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=embedded-page) · [Stripe test cards](https://docs.stripe.com/testing)

Stream disables completion redirects in Stripe. The filmmaker’s Stripe configuration determines which eligible payment methods appear. An issuer can ask the viewer to verify a payment. Stripe recommends avoiding nested frames for methods that require redirects. If the publisher adds an iframe sandbox, allow scripts, same-origin access, forms and downloads for Stream. Test checkout with the publisher’s actual embed policy. [Stripe embedded Checkout](https://docs.stripe.com/payments/accept-a-payment?payment-ui=checkout&ui=embedded-page) · [Checkout completion behavior](https://docs.stripe.com/payments/checkout/custom-success-page?payment-ui=embedded-page)

For a repeatable browser regression, generate the clock fixture with `npm run fixture` once, then run `npm run check:viewer-checkout`. It exercises separate publisher and player origins, real media playback, and a simulated payment provider.

## Try the preview

Use Node 22.23.4+, 24.22.1+, or 26.12.1+ on those major lines, and FFmpeg with libx264 and AAC. The fixture generator makes a 136-second clock with a tone that changes pitch at ten seconds.

```sh
git clone --recurse-submodules https://github.com/aindaco1/stream.git
cd stream
npm ci
npm run fixture
npm run rental:test -- --init
STREAM_SOURCE=file npm start
```

Open [the player](http://127.0.0.1:8787/embed/clock) and choose **Play 10-second preview**. For an existing checkout, run `git submodule update --init` before `npm ci`.

## Read a private R2 film

1. Sign in to your existing Cloudflare account, or create one, enable R2, and create a dedicated private bucket. Keep the public development URL disabled and leave custom domains disconnected. A read-only R2 token can read every object in the selected bucket.
2. Use the synthetic `.local/clock.mp4` for the first test. For any other film, confirm you own or have permission to distribute it before uploading. Upload the file in the R2 dashboard under **Objects** and keep its exact object key. The playback service uses the existing object.
3. From R2’s API token settings, create a token with **Object Read only**, select **Apply to specific buckets only**, and choose this bucket. Give test credentials an expiry. Save the access key ID and secret access key when Cloudflare displays them. [Cloudflare R2 token guide](https://developers.cloudflare.com/r2/api/tokens/)
4. Run `npm run rental:test -- --init` to create the private operator directory. On macOS it is `~/Library/Application Support/Dust Wave Stream Prototype`. On Linux it is `~/.local/state/dust-wave-stream-prototype`. Set `STREAM_STATE_DIR` to override it across commands. In this directory create the two plain-text files below with owner-only permissions (0600). Keep the directory outside a repository or synced folder.

`source.env`

```dotenv
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET=your-private-bucket
R2_OBJECT_KEY=your-film.mp4
```

`r2.env`

```dotenv
R2_ACCESS_KEY_ID=your-bucket-scoped-access-key-id
R2_SECRET_ACCESS_KEY=your-bucket-scoped-secret
```

5. Run `npm run inspect`. It reads the film and prints its duration, segment count and opaque revision. Run `npm start` and open the player. The playback process signs HEAD and conditional byte-range GET requests server-side. Replacing the object invalidates subsequent media reads. Restart and inspect the new revision before issuing a new rental.

The supported source is a seekable MP4 with baseline H.264, optional AAC-LC audio, a keyframe at zero and keyframe intervals up to twelve seconds. The 1 GiB, four-hour, index, packet and rendering limits bound this prototype. A preview must end before the film ends. A complete encoded packet that crosses the cutoff is omitted.

## Reuse the feature-length film

Run `npm run fixture -- --feature` to create `.local/feature-clock.mp4`. The video is a 90-minute synthetic projection chart with an elapsed-time display. It uses 12 fps baseline H.264, mono AAC and four-second keyframes. The 440 Hz preview tone changes to 660 Hz at ten seconds, then rises 60 Hz every fifteen minutes. The cues at 05:00, 45:00 and 89:00 are 660, 840 and 960 Hz. The fixture stays available in its bucket between test runs. The generator can recreate it for a new account.

To run the two-filmmaker rehearsal, keep the short film in the first bucket. Create a second private bucket in the same account, upload the feature there and issue a separate **Object Read only** key scoped to that bucket. Under the operator directory, create a `feature/` directory with its own `source.env` and `r2.env` using the file formats above. Keep both directories private.

```sh
# Use the base operator directory for inspection and for running the server.
npm run inspect -- feature
# Substitute your feature operator directory and the revision printed above.
STREAM_STATE_DIR="/path/to/operator/feature" npm run rental:test -- maker-b/feature REVISION_FROM_INSPECT
npm start
```

The feature operator gets a separate signing key, test order and receipt. Keep the order journal for retries. After a receipt expires, archive that filmmaker’s completed `test-order.json` privately before starting a fresh sandbox purchase. The signing key and R2 object can be reused. The short and feature routes are `/embed/clock` and `/embed/feature`. Each has its own offer and permission scope. The public embedding page contains only the public iframe URLs. Supply the rental receipt to the buyer's individual player.

## Verify a filmmaker’s sandbox sale

Save a film through filmmaker setup and connect that filmmaker’s Stripe sandbox account. Supply the platform sandbox key as `STRIPE_CONNECT_SECRET_KEY` using your local secret manager. Use the same operator directory as setup. Copy the saved film ID from its private preview URL.

```sh
npm run rental:test -- --connected "Filmmaker name" f-SAVED-FILM-UUID
```

The command checks the original’s recorded revision, rights and seller ownership, then refreshes Stripe’s card and payout status. It charges USD 0.99 directly to the connected sandbox account using Stripe’s test Visa. It retrieves the saved PaymentIntent in that account, reconciles the charge and its processing fees against the connected balance transaction, and verifies a 48-hour receipt for the saved film. The accounting evidence includes total fees and a breakdown of Stripe fees, pass-through fees, and taxes when present. This rehearsal requires a USD settlement balance and itemized fee details. The balance status shows whether funds are pending or available in the connected Stripe sandbox balance. During the 48-hour rental, rerun the same command to refresh that evidence. [Stripe direct charges](https://docs.stripe.com/connect/direct-charges) · [Balance transaction details](https://docs.stripe.com/expand/use-cases)

One sandbox order is reserved for each saved film. Retries and concurrent runs share that order. The operator directory contains the private receipt and redacted accounting evidence in `connected-test-rentals/FILM_ID/receipt.txt` and `evidence.json`. The receipt is validated inside the operator command. The filmmaker’s setup preview remains the available web route for this film.

## Exercise a paid rental

Use the operator CLI with a Stripe sandbox secret supplied through your local secret manager as `STRIPE_TEST_SECRET_KEY`. The player needs only its signing and read-only storage credentials. This demo charges USD 0.99 in the sandbox account that owns the supplied key. To test a filmmaker’s connected balance, use the saved-film command above. For the same operator directory, a retry retrieves or resumes the same order. [Stripe testing guide](https://docs.stripe.com/testing)

```sh
npm run inspect
npm run rental:test -- clock REVISION_FROM_INSPECT
```

For a file-backed rehearsal, set `STREAM_SOURCE=file` for the inspection and player. The CLI verifies the captured payment, amount, currency, film and revision before saving `receipt.txt` in the private operator directory. Rental time starts at Stripe’s successful charge timestamp. The private player URL is `/embed/clock#receipt=SIGNED_RECEIPT`. Keep it with the buyer. It is a bearer credential. The player removes it from the address bar on load. A public embed only needs the public player URL.

Each iframe keeps its own session in memory. The server checks a short-lived, film-specific grant for every rental playlist, key and segment. The player sends the grant in a request header. The browser receives AES-128 HLS and the data needed to play it. A viewer with valid access can capture playback. New receipt issuance checks the current payment status. Hosted sales will also need webhook-driven revocation of outstanding access after a refund or dispute.

## Verify

```sh
npm test
npx playwright install chromium
```

The browser check requires a built copy of Dust Wave Downloader. Set `STREAM_DOWNLOADER_PATH` to its unpacked extension directory. The default is the sibling checkout’s `../downloader/extension`. Start the player, then run the check in a second terminal. It uses a disposable Chromium profile with third-party cookies blocked and writes a redacted report under `test-results/`. Override the destination with `EVIDENCE_DIR`.

```sh
npm run check:browser -- --preview-only
STREAM_RECEIPT_FILE="/path/to/operator/receipt.txt" npm run check:browser
```

The full check uses the ordinary extension popup on the player and on a separate embedding origin. It measures saved media with FFprobe, decodes it with FFmpeg, and checks the paid stream at two minutes. The combined page has two copies of the first player and a second film ID. Both IDs deliberately share the single synthetic source in this test. To scan browser-visible responses for your actual storage identifiers, run the check with the nonsecret source settings loaded, for example with `node --env-file="/path/to/operator/source.env" scripts/check-browser.js`.

### Safari playback rehearsal

The 90-minute fixture passed on macOS Safari 27.2, iPhone Simulator and a physical iPhone 16 Pro Max with iOS 27.2.1. Its clock matched the original after seeks to 45:00, 89:00 and back to 5:00. In both rental directions the neighboring film stopped at ten seconds while the rental kept playing.

Configure both R2 films and their sandbox receipts, and keep the two local fixture originals for frame comparisons. Start the player with `PORT=8895 npm start`. In a second terminal on macOS, run `node scripts/check-safari.js desktop` with Safari’s WebDriver available. The harness opens an external embedding page, rents one film while leaving its neighbor preview-only, and repeats with the roles reversed. It compares the clock in presented video frames against the original MP4s. Set `EVIDENCE_DIR` to save the JSON report to a private directory of your choice.

For an iPhone on the same private Wi-Fi, leave the loopback player running. On the Mac run the following, substituting the Wi-Fi interface if it differs from `en0`.

```sh
STREAM_PUBLISHER_BIND="$(ipconfig getifaddr en0)" \
STREAM_PUBLISHER_HOST="$(scutil --get LocalHostName).local" \
node scripts/check-safari-manual.js
```

Scan the QR image at the path the command prints. In ordinary iPhone Safari, tap **Play rental**, then **Play 10-second preview**. The test switches the films after the preview ends. Repeat the two taps and wait for the completion message. The invitation is single-use, lasts ten minutes, and exercises only the synthetic fixtures. The relay keeps the receipts on the player side and closes after the test. The Mac saves the frame comparisons and the preview endpoint in the evidence directory. This local HTTP fixture test can run with the iPhone’s Developer Mode off.

## Path to a hosted pilot

1. Use both private R2 fixtures to measure sustained playback, concurrent viewers, storage operations and delivery cost. Before admitting unrelated filmmakers, also rehearse account connection and seller settlement with separately owned accounts. Isolate the media parser before accepting public uploads.
2. Add filmmaker sign-in, rights acceptance before upload/registration and guided setup for new and existing Cloudflare and Stripe accounts. Release the characterized, reusable setup cards through Dust Wave Platform for independent adoption by Stream, Pool and Store.
3. Extend the sandbox viewer checkout to production with refund and dispute revocation for outstanding receipts, plus cross-device rental recovery. Exercise simultaneous purchases from different sellers. Add adjustable rental durations and the optional platform tip.
4. Add the filmmaker dashboard, viewing counts, basic analytics and pilot publishing controls. Qualify additional storage and payment providers after measuring the R2 pilot.

Stream owns the player, film policy and routes. Its Platform dependency is pinned to a git submodule revision with worker-core 0.16.1. Revert the consumer commit that changes the pin to roll back independently. Stream’s own code is MIT licensed. Its dependencies retain their respective licenses.
