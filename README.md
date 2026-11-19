# Dust Wave Stream

An open-source film player for filmmakers who keep their originals in their own storage. This prototype reads a single private Cloudflare R2 object, serves a ten-second preview, and unlocks a 48-hour rental after a Stripe sandbox purchase. The player runs on localhost. It makes no persistent streaming copies.

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

## Exercise a paid rental

Use the operator CLI with a Stripe sandbox secret supplied through your local secret manager as `STRIPE_TEST_SECRET_KEY`. The player needs only its signing and read-only storage credentials. The CLI makes a one-time USD 0.99 sandbox payment with Stripe’s test payment method. For the same operator directory, a retry retrieves or resumes the same order. [Stripe testing guide](https://docs.stripe.com/testing)

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

## Path to a hosted pilot

1. Repeat the media test with a feature-length film in a second filmmaker-owned R2 account. Measure seek time, startup, storage operations and cost under concurrent load. Exercise Safari, including a physical iPhone. Isolate the media parser before accepting public uploads.
2. Add filmmaker sign-in, rights acceptance before upload/registration and guided setup for new and existing Cloudflare and Stripe accounts. Release the characterized, reusable setup cards through Dust Wave Platform for independent adoption by Stream, Pool and Store.
3. Build filmmaker-scoped Checkout, signed webhooks, revocation and receipt recovery. Exercise simultaneous purchases from different sellers in independent iframes. Add per-film rental terms, a buy-to-download option and the optional platform tip.
4. Add the filmmaker dashboard, viewing counts, basic analytics and pilot publishing controls. Qualify additional storage and payment providers after measuring the R2 pilot.

Stream owns the player, film policy and routes. Its Platform dependency is pinned to a git submodule revision with worker-core 0.16.1. Revert the consumer commit that changes the pin to roll back independently. Stream’s own code is MIT licensed. Its dependencies retain their respective licenses.
