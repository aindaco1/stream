# Dust Wave Stream

An open-source film player for filmmakers who keep their originals in their own storage. Each test filmmaker connects a private Cloudflare R2 object, chooses the preview length and sets prices for a timed rental, a one-time purchase, or both. Viewers pay and watch in the filmmaker’s embed. A purchase also includes the original MP4. The setup and viewer services bind to loopback and can sit behind HTTPS. Stream reads the original from the filmmaker’s bucket and creates each playable segment on demand.

## Guided filmmaker setup

Start Stream with `npm start` and give each pilot filmmaker their own sign-in link. In a second terminal, run:

```sh
npm run invite -- "Filmmaker name"
```

The filmmaker opens the link and selects **Open settings**. It expires after 30 minutes and can be used once. Their signed-in session lasts 14 days. For a returning filmmaker, issue another invite with the same unique name to reopen their workspace. The operator can use a private handoff to share the invitation. The default local link works on the Mac running Stream.

1. **Get paid with Stripe.** To create a connected account, select your business country in Stream, then continue to Stripe for identity and payout details. You can sign in to Stripe to reuse eligible business details. If Dust Wave offers **Connect my Stripe account**, select an eligible existing Standard business directly on Stripe. Return to Stream to see what is ready or needs attention. Both payment and payout capabilities must be active. You can proceed with storage while Stripe reviews your information.
2. **Connect Cloudflare R2.** Choose or create a dedicated private bucket in Cloudflare, then paste its dashboard URL into Setup. Create an **Object Read & Write** token limited to that bucket. Enter the token value or its access key pair and confirm the scope and encrypted storage. Stream checks the connection by writing and removing a small test object. Filmmakers with an existing read-only connection can enable uploads once in Storage settings. [Cloudflare R2 permissions and credentials](https://developers.cloudflare.com/r2/api/tokens/)
3. **Add a film.** Choose **Dashboard → Add a film** and confirm you own the distribution rights. Choose an MP4 up to 1 GiB from your device, or enter the object key of an existing file. Set a title, prices and preview length, then choose **Check film and create preview**. Stream sends new uploads to a unique key in your bucket in 8 MiB parts, validates the original and saves the film privately. Open **Watch private preview** on its film card.

A filmmaker can set the rental and purchase prices for a film in setup. Leaving a price blank removes that offer from new checkouts. Existing saved films start with their previous $0.99 rental. New films stay private to their filmmaker during setup. The existing public demo players and sandbox purchase rehearsal are described below.

**Settings** guides filmmakers through Payments and Storage and shows the fees for each connection. The header links to the public **FAQ** at `/faq`, which includes rates and worked examples.

Use the **🌓** appearance selector in the filmmaker header to follow your system or choose **Light** or **Dark**. Your browser remembers the choice across sign-in, setup and the dashboard.

### Filmmaker dashboard

Open **Dashboard**. **Overview** shows totals, followed by **Films**. On a phone, choose Dashboard from the **Filmmaker workspace** menu. Open a film by its title, set rental and purchase prices, choose 1–720 rental hours and a preview of 0–30 whole seconds, then publish and copy the embed code. A zero-second preview shows the offers immediately. The preview must end before the film does. The filmmaker can change future offers without altering the price or expiry of an existing order.

Save an optional synopsis, credits and a filmmaker message under **Film details**. For a published film, select which fields to include under **Embed this film**. The live preview and copyable code show the same player with the same selected fields. Saved edits appear when existing embeds load again. Embeds with no fields selected show the player alone.

Each film shows its own counts. **Overview** shows totals across your films for preview starts, paid plays, rental and purchase counts, gross USD test payments and refunds recorded by Stripe. Starts are player-reported playback events. Repeat screenings count, while seeking, pausing, fetching media ranges and retrying the same event do not add views. Unpublishing removes the preview, blocks new orders and expires open Stripe checkouts. If Stripe is temporarily unreachable, the dashboard reports outstanding closures and Stream retries. Existing renters and buyers keep access under their original terms.

Under **Dashboard → Films → Thumbnail**, choose a JPEG, PNG or WebP up to 8 MB. A 1920 × 1080 image fits the player. Preview its framing and save. You can adjust, replace or delete the image on the same card. Stream saves a JPEG with the crop settings at `stream-thumbnails/<film-id>.jpg` in the film’s bucket. Published embeds pick it up on reload. The server signs short-lived credentials for each write and read-only credentials for playback. [Cloudflare’s scoped R2 credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

### Operator configuration

The setup and viewer services run on loopback and share the same private SQLite database. For a hosted pilot, terminate TLS ahead of the server, forward the original Host, and set `STREAM_PUBLIC_ORIGIN` to the exact HTTPS origin in both the service and invite CLI. Keep query strings, invitation links, form bodies and credentials out of proxy logs. Do not forward payment callbacks to the demo rental CLI.

| Setting | Purpose |
| --- | --- |
| `STREAM_STATE_DIR` | Private state directory, outside the checkout and cloud sync. The `filmmakers/` subdirectory holds SQLite and its owner-only credential encryption key. Back up both privately. Run one filmmaker setup service and one viewer service per state directory on the same host. |
| `STREAM_VIEWER_ORIGIN` | The public HTTPS viewer origin used in dashboard embed code when setup and playback use different hosts. Local setup defaults to the viewer at port 8793. |
| `STREAM_LOCAL_PREVIEW_PORT` | Optional separate port on 127.0.0.1. Set the same value for the local setup and viewer services to let the dashboard preview films directly. Copied embeds continue to use the public viewer origin. |
| `RESEND_API_KEY`, `STREAM_RECOVERY_FROM` | Enable viewer-requested access emails with a Resend key and verified sender. Keep secrets in the viewer environment. On startup the service checks older active orders for their verified checkout address without emailing those viewers. |
| `STREAM_RECOVERY_TEST_TO` | Limit recovery mail to one exact recipient in a shared sandbox, such as `delivered@resend.dev`. |
| `STRIPE_CONNECT_SECRET_KEY` | Dust Wave’s server-side Connect platform key. Use a sandbox key for rehearsal. Filmmakers enter identity and bank information on Stripe. |
| `STRIPE_CONNECT_CLIENT_ID` | Optional, mode-matching Standard OAuth client ID. Enable eligible existing-account connections in the Connect platform and register the exact `/setup/stripe/oauth` redirect on your origin. |
| `STRIPE_CONNECT_LIVE` | Test mode is the default. Live onboarding requires an explicit value of `1`, a matching live platform key and an HTTPS origin. Test and live connections are stored independently. |

Configure the platform for Accounts v2 merchant onboarding with a full Stripe Dashboard, direct charges and Stripe-managed fees and losses. Set Connect branding, enable networked onboarding to reuse eligible details, and configure collection of external payout details. The card stays available for explanation when the operator has not configured Connect. Storage and private previews work independently. [Stripe-hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding?accounts-namespace=v2) · [Networked onboarding](https://docs.stripe.com/connect/networked-onboarding) · [Existing Standard accounts](https://docs.stripe.com/connect/oauth-standard-accounts)

To start Stripe setup over, open **Settings → Payments**. Select **Reset Stripe connection**, review the named seller and mode, and confirm. New sales on published films resume when a connected account is ready. Unfinished checkouts on the old account are closed. Settled orders keep their original seller, payment history and viewer access. Reset changes Stream’s active connection. The filmmaker can manage provider authorizations separately in Stripe.

The setup cards come from Admin Shell **0.19.0** in the pinned Dust Wave Platform submodule. Stream owns the filmmaker sessions, rights records, provider calls and media checks. To run the form rehearsal, install Chromium with `npx playwright install chromium` and run `npm run check:setup`. This browser rehearsal uses simulated provider responses, real forms and the private preview renderer. The sandbox sale commands below contact Stripe and create test payments. [Cloudflare R2 credentials](https://developers.cloudflare.com/r2/api/tokens/) · [Cloudflare uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)

## Public viewer checkout in a Stripe sandbox

Finish setup, save a film and select **Check Stripe status**. When charges and payouts are enabled, publish the verified film from the filmmaker dashboard. Existing `STREAM_PUBLIC_FILMS` entries continue to work. Explicit unpublishing in the dashboard takes precedence. Use the same legacy list in the setup and viewer environments while those entries are in use.

```dotenv
STREAM_PUBLIC_FILMS='[{"owner":"Example filmmaker","id":"f-00000000-0000-4000-8000-000000000001"}]'
```

Run `npm run viewers` with the same `STREAM_STATE_DIR` as setup, the Store sandbox’s matching `STRIPE_CONNECT_SECRET_KEY` and `STRIPE_CONNECT_PUBLISHABLE_KEY`, and a 32-byte base64url `STREAM_RENTAL_SECRET` (or the state directory’s existing `rental.env`). Set `STRIPE_CONNECT_WEBHOOK_SECRET` to the signing secret for this listener. For a local rehearsal, run the following from a Stripe CLI session authenticated to the same sandbox and keep the listener running.

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.refund.updated,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.updated,charge.dispute.closed,charge.dispute.funds_withdrawn,charge.dispute.funds_reinstated \
  --forward-connect-to http://127.0.0.1:8793/checkout/webhook
```

Open `http://127.0.0.1:8793/screening`. To share it over HTTPS, set `STREAM_PUBLIC_ORIGIN` to the exact viewer origin, forward the original Host header, and set the CLI’s `--forward-connect-to` URL to that same HTTPS origin plus `/checkout/webhook`. A localhost destination is for a viewer running with its localhost origin. The viewer service exposes only explicitly published films and viewer routes. For a registered Stripe webhook destination, choose events on **Connected accounts** and use that destination’s own signing secret. [Stripe Connect webhooks](https://docs.stripe.com/connect/webhooks)

Embed a published film on another site with its viewer URL. Let the iframe shrink with its container and allow vertical scrolling for small screens, larger text, and bank verification. Use HTTPS for the publisher and the player.

```html
<iframe src="https://stream.example.org/embed/f-00000000-0000-4000-8000-000000000001"
  title="Film title" width="640" height="570" style="max-width: 100%; box-sizing: border-box"
  allow="autoplay; fullscreen; payment" allowfullscreen></iframe>
```

After the preview, viewers choose a timed rental or a one-time purchase when the filmmaker offers it. The film title, offer and total appear together in the player. Stripe hosts the email and card fields and supports browser autofill. Viewers can also type their details. The Pay button stays in view as the fields scroll in short embeds, displays the total from Stripe and accepts a single submission while confirmation is in progress. An issuer may ask for card verification. Normal card payments complete in the player. [Stripe Payment Element](https://docs.stripe.com/payments/payment-element) · [Stripe confirmation](https://docs.stripe.com/js/custom_checkout/confirm)

Stream verifies the direct charge on the filmmaker’s connected account before unlocking playback. Each embed keeps its own order. Rentals run from payment and show the expiry in the viewer’s local time. Buyers can watch and download the original MP4. All sales are final. Stream provides no refund action. If Stripe records an external full refund or lost dispute, Stream stops serving new media to that order. A new or renewed playback grant also rechecks Stripe if the last verified payment read is over five minutes old. An open dispute pauses access, a win restores eligible access, and a partial refund is reflected in the dashboard. Previously buffered media and completed downloads remain on the viewer’s device. [Stripe direct charges](https://docs.stripe.com/connect/direct-charges) · [Stripe test cards](https://docs.stripe.com/testing)

Choose **Watch on another device** after renting, or **Save purchase link** after buying. The private link restores that order and its saved position. Anyone with a copy can use its access. Keep it out of public embed code. With recovery email configured, a viewer can also select **Restore access** and enter the email used at checkout. The emailed link expires after 15 minutes and is consumed when the viewer selects **Restore and watch**. Stream stores a keyed address fingerprint. A new device uses the same order and expiry.

New sandbox orders use Stripe Checkout Sessions with the Payment Element and offer card payment. Earlier orders can finish on their original checkout. Saved-card suggestions depend on the browser, its settings, and the publisher’s iframe permissions. If the publisher adds an iframe sandbox, allow scripts, same-origin access, forms and downloads for Stream. Test checkout and bank verification under the publisher’s actual embed policy. [Stripe integration security](https://docs.stripe.com/security/guide) · [Stripe card authentication](https://docs.stripe.com/payments/3d-secure)

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

Each iframe keeps its own session in memory. The server checks a short-lived, film-specific grant for every rental playlist, key and segment. The player sends the grant in a request header. The browser receives AES-128 HLS and the data needed to play it. A viewer with valid access can capture playback. New receipt issuance checks the current payment status. Published sandbox films additionally check the local payment ledger on playback and download requests after signed Connect events.

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
2. Validate the hosted pilot with independent filmmakers and measure checkout, email delivery and recovery under publisher embed policies. Add live-mode operation, operational monitoring and the optional Dust Wave tip.
3. Qualify additional storage and payment providers after measuring the R2 pilot.

Stream owns the player, film policy and routes. Its Platform dependency is pinned to a git submodule revision with worker-core 0.16.1. Revert the consumer commit that changes the pin to roll back independently. Stream’s own code is MIT licensed. Its dependencies retain their respective licenses.
