# Live viewer payments

Use a separate live ledger, credential vault and playback signing secret. The application rejects a sandbox ledger in live mode and does not carry over sandbox sellers, orders or viewer access. Set the viewer origin to `https://watch.streamyourfilm.com`. The operator’s Stripe secret stays on the server.

## Open sales

1. Connect the live platform and give Stream its matching live secret and publishable keys. Set `STRIPE_CONNECT_LIVE=1` and `STREAM_STRIPE_TAX_MODE=marketplace`. Filmmakers complete live Connect onboarding separately.
2. Configure enabled, signed Stripe event destinations for both account scopes. Platform events go to `https://watch.streamyourfilm.com/checkout/platform-webhook`. Connected-account events go to `https://watch.streamyourfilm.com/checkout/webhook`. Supply the respective secrets as `STRIPE_PLATFORM_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`. The supported event names are exported as `viewerWebhookEvents` in `src/viewer-checkout.js`. Use Stripe’s event delivery log to verify each destination.
3. Confirm Stripe Tax is active and the operator’s live registrations are recorded. With the live service environment loaded, run `node scripts/check-live-stripe.js`. It reads the account, active registrations, webhook configuration and fee-report availability. The final signature check requires an actual signed event. The command only makes GET requests.
4. Set `STREAM_SALES_TERRITORIES=worldwide` for the approved pilot. Viewers can buy wherever Stripe accepts their payment. The viewing-location step checks New Mexico addresses for a local rate. Other orders use Stripe Tax on the address collected in Checkout. Unresolved New Mexico locations use Stripe’s viewing-address field. Confirm enabled live registrations cover the locations where the operator must collect. Stripe Tax Basic calculates collection. The operator remains responsible for registrations, filing and remittance.
5. To pause new purchases or rentals, clear `STREAM_SALES_TERRITORIES` and restart the viewer service. Keep the keys, event destinations and ledger attached. Stream marks outstanding open sessions for expiration and reconciles payments already submitted. Confirm Stripe has expired the outstanding sessions. Existing purchases and unexpired rentals retain access.

The same setting accepts a comma-separated list of approved countries. Stripe constrains its viewing-address form to those countries. `US-NM` restricts new purchases to a New Mexico address whose tax district Stream can verify before opening Checkout.

## Settlement

A card payment that Stripe confirms unlocks the film immediately. The filmmaker’s transfer waits for verified card fees and their confirmed share of Stripe Tax Basic. The scheduled Worker wakes the container when a payment needs reconciliation. The private maintenance route polls Stripe for pending itemized fees, imports matching transactions, and retries transfers.

For an automatic-tax order, fee data can take up to 96 hours after the fee affects the balance. Stream checks the itemized report by the UTC day the fee originated. Missing or ambiguous rows leave the transfer pending. Grant reporting access for the platform to read the report type and results and request report runs. Inspect the report in the Stripe Dashboard if an order remains pending. [Stripe Fees report](https://docs.stripe.com/reports/all-fees)

For an operator-reviewed import, run `npm run tax:fees -- import ACCOUNT ITEMIZED.csv` from the configured operator runtime. To list unresolved orders use `npm run tax:fees -- pending ACCOUNT`. Confirm zero only with evidence from a completed Stripe report. The New Mexico manual-tax path records a zero Stripe Tax Basic fee at checkout and can settle as soon as Stripe confirms the card fee. Use Stream’s New Mexico reporting instructions for those transactions. [New Mexico reporting](new-mexico-grt.md)

For the first genuine purchase, match the order to its paid Checkout Session, successful charge and connected-account destination. Confirm that the filmmaker’s transfer is tied to the original charge after the actual fees arrive. A later bank payout has its own Stripe status.

The live super-admin dashboard links **Review pending Stripe Tax fees** when an automatic-tax charge is waiting. Select a charge and enter the completed incurred-at Fees report ID. Stream retrieves that report from the live platform account and matches the transaction. If you separately verified a zero fee in Stripe, the checkbox records that decision with your operator identity, timestamp and report ID. For a zero decision the report must include the charge date and have been created at least four days after payment.

For New Mexico filing, choose the reporting month in the live super-admin overview and select **Download totals**. The CSV uses New Mexico calendar months, reports paid film and tip receipts net of included tax, and separates the tax on each. Combine these manual district totals with Stripe's automatic-tax records and review flagged disputes or adjustments. The export sends no filing or payment.

For coupon orders, subscribe both payment-event destinations to `checkout.session.expired` so an expired session releases its reserved use promptly. Scheduled reconciliation also checks for missed expirations. The read-only provider check validates the events listed in `viewerWebhookEvents`. Check the expiration subscription separately in each destination’s event list. On November 26 (UTC), both live destinations were enabled and neither subscribed to expiration events. Until those subscriptions change, scheduled reconciliation releases expired holds when it next checks the order.

## Rehearsal evidence, November 21, 2026

After restarting the sandbox viewer, an unauthenticated Helium session stopped *Shorts test* at exactly 10 seconds and displayed both offers. A separate paid sandbox rental started at the intro in 2.56 seconds. Playback resumed after seeking to 92 seconds in 0.69 seconds and back to 24 seconds in 0.98 seconds. The viewer moved through all five titles, retained English captions on returning to the subtitled title, and fetched 44 paid segments with no recorded player errors, stalls or dropped frames. This used the open-web rehearsal tunnel and an existing Stripe sandbox rental.

The inline checkout browser suite passed five desktop/mobile viewport sizes, including the keyboard-sized embed. Synthetic live-mode tests covered a paid purchase, access, transfer settlement, incorrect object modes, separation of state and signing keys, and signed webhooks. The first genuine live sale and bank payout still require production verification.

## Production verification, November 21, 2026

The deployed viewer and filmmaker workspace passed their readiness checks. The media process decoded its test frame after a cold start and reported the worldwide checkout setting. The restricted Stream key confirmed that the platform can charge and pay out, that New Mexico is its active Stripe Tax registration, and that the itemized fee report is available.

Stripe opened a live inline Checkout Session for a $2 rental and a 20¢ tip with automatic tax enabled. The session expired unpaid. Each public webhook endpoint acknowledged a locally signed configuration check using its own destination secret. On November 21, neither destination was subscribed to session-expiration events. Verify Stripe’s delivery of the first actual payment event, viewer access, the filmmaker transfer and the subsequent bank payout against the real order.

## Coupon release verification, November 26, 2026 (UTC)

A 100% coupon completed both a rental and a purchase in Stripe’s sandbox through the embedded checkout. Each order granted access and could be recovered with the checkout email. Only the purchase granted the original download. Both orders settled at $0 with no charge or filmmaker transfer.

On production, the workspace and media runtime served the release, the coupon and subtitle tables were present in the live ledger, and the homepage film played and sought in the browser. The sandbox results cover complimentary orders. Verification of a real card payment, transfer and bank payout uses the settlement procedure above. [Stream release PR](https://github.com/aindaco1/stream/pull/42)
