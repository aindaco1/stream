# Film programs

**Stream pilot scope and acceptance criteria.** A filmmaker can sell a double feature or shorts program through one embed. They choose the lineup, order, cover image, preview, and offers. A viewer can see what’s included, pay once, and watch every included title in that player.

## Creating a program

1. **Build the lineup.** Add **Create program** beside **Add a film** in the Dashboard. Give the program a title, select at least two films from the filmmaker’s library, and arrange them with drag handles or accessible Move up and Move down buttons. Show each title, runtime, and the program’s total runtime. Save a draft at any point.
2. **Add an opening or closing video if desired.** Give each its own slot. Choose from the filmmaker’s library or upload through the existing rights confirmation and private R2 upload flow. An extra can belong exclusively to the program. Keep it out of standalone public listings unless the filmmaker publishes it separately.
3. **Choose the artwork and preview.** Give the program its own thumbnail with the existing upload, crop, replace, and remove controls. Use the first film’s poster as a fallback. The filmmaker chooses one lineup item and a preview length, using the current 0–30 second control. Default to 10 seconds of the first main film when its runtime permits. A zero-length preview opens the offers immediately. Enforce the limit on the server for the selected source. Browsing the lineup never starts another free excerpt.
4. **Set the offer.** Enable rental, purchase, or both. Set the program’s own prices and rental duration. Show exactly which originals a purchase will include before the filmmaker publishes. Existing standalone film offers retain their own terms. The single filmmaker confirms they can offer the complete selection for each enabled use and receives the proceeds through their connected Stripe account.
5. **Preview and publish.** Present the program under **Programs** below **Films** on the Dashboard. Use the existing live preview and copy-embed controls so the filmmaker can check the lineup, artwork, offers, and framing before pasting one snippet on their site.

## What viewers see

| Moment | In the embed |
| --- | --- |
| Before payment | A program poster overlays the player. Below it, show the title, film count, total runtime, and a compact lineup. Keep each film’s title and runtime visible. Expand a title to see its poster, synopsis, credits, and filmmaker message where supplied and enabled for the embed. Mark opening and closing videos separately. |
| At the paywall | Offer an explicit action such as **Rent both films for $4 · 48 hours** or **Buy program · $8, includes ZIP**. Use the existing inline payment form, optional tip, and tax total. Keep the pay button reachable on a small screen. |
| After payment | Start at the opening video if supplied, continue in the chosen order, and finish with the closing video. Viewers can skip extras or choose any included film immediately. Use one player with **Previous title** and **Next title** controls. Keep the viewer’s caption language where available, remember it through titles without a matching track, and preserve an explicit Off selection. Track the current title and position so **Continue watching** and the program’s private recovery link return to the right place. The rental clock starts at payment and covers the whole program. |
| After purchase | Show **Download program (.zip)** with its approximate size. Each original is a separate file, numbered in screening order, including any opening and closing videos. Keep individual downloads available to buyers who need only one film or have an interrupted connection. |

Use the same black-and-white design as the film embed. On a wide site the lineup can sit beside the player. On mobile it sits beneath the offer or player. Opening a film’s credits should expand that row only. A program and a standalone film from another filmmaker must work side by side on the same page.

## Build sequence and acceptance checks

| Stage | Work and completion check |
| --- | --- |
| 1. Program editor and publication | Store programs and ordered membership in Stream. Reference each existing film and its R2 original. Reuse the upload and thumbnail controls for extras and posters. Give programs a stable embed URL and a version for each published lineup. Verify keyboard and touch ordering, optional slots, artwork fallback, and a private preview before publication. |
| 2. Embed and preview | Render the lineup with one playback element and fetch the chosen film’s details on demand where useful. Exercise posters, subtitles, picture-in-picture, title switching, and the paywall on desktop, in Safari, and on iPhone. Check zero and timed previews, plus two independent embeds on the same page. |
| 3. Checkout, playback, and recovery | Reuse inline Stream checkout, Stripe Connect, and the existing tip and tax flow. At checkout, capture the program version, ordered film IDs and media revisions, recipient, price, and rental terms. On confirmed payment, issue access only to titles in that order. Track revenue once per program order and views against the film played. Verify one charge and one filmmaker transfer in the Store sandbox, including a payment retry, recovery on another device, rental expiry, and an unrelated embed that stays preview-only. |
| 4. Purchased ZIP | Authorize the buyer’s saved order and check availability of its original files before starting. Stream a ZIP64 archive from private R2 reads using an established streaming ZIP writer in store mode. This preserves each original and its embedded subtitles, bounds server memory, and avoids storing a second copy. Use safe, unique filenames and keep bucket URLs private. Test archives above 4 GB, duplicate titles, an interrupted transfer, a changed or missing original, and extraction on macOS and iPhone. Compare extracted bytes with each original. |
| 5. Release and explain | Rehearse edits and unpublishing. A paid order keeps the lineup and terms it purchased, as long as its original files are still available. Taking a program offline stops new sales. If a required source is withdrawn, pause affected new offers and identify the issue to its owner. Verify existing standalone receipts, previews, and sales. Add the FAQ example below when programs become available. |

The sandbox rehearsal uses two short films from one filmmaker, a second filmmaker’s standalone film on the same page, and distinct opening and closing clips. It exercises both rental and purchase, title navigation, caption preferences, recovery and ZIP extraction. Program-specific data and UI belong in Stream. Reuse existing Dust Wave components where their current behavior fits.

## FAQ example

**Can selling films as a program save on fees?** Yes, when the same viewer would otherwise pay for each film separately. For example, two separate $2 rentals cost about 72¢ in card fees at Stripe’s standard U.S. domestic card rate. A $4 double feature costs about 42¢, leaving about 30¢ more for the filmmaker at the same total price. This example assumes no tax or tip. Actual fees depend on the payment and your pricing. [Stripe pricing](https://stripe.com/pricing)

**Pilot defaults.** The pilot has one filmmaker per program, one replayable preview excerpt per program, and opening and closing videos included in the purchase ZIP. These choices keep one payee, one clear offer, and the same lineup for watching and downloading.
