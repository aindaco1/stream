import { payoutCountryOptions } from './payout-countries.js';

export function renderFilmmakerFaq() {
  const countries = payoutCountryOptions.map(country => country.label).join(', ');
  return `<h1>FAQ</h1>
    <p class="faq-intro">Put your film wherever your audience finds you on the open web. You keep your rights, choose the price and decide where it plays. Viewers can preview, pay and watch without leaving the page.</p>
    <section id="embed"><h2>How do I put a film on my site?</h2>
      <ol><li>In <strong>Dashboard → Films</strong>, open your film, choose the rental or download price and publish it. For a double feature or a shorts lineup, open it under <strong>Programs</strong>.</li>
        <li>Find <strong>Embed code</strong>. Choose which details to show, such as credits or a synopsis. Check the live preview, then select <strong>Copy embed code</strong>.</li>
        <li>In your website editor, add a <strong>Custom HTML</strong>, <strong>Embed</strong> or <strong>Code</strong> block where the player should go. Paste the whole snippet into that block and publish your page.</li>
        <li>Open the published page as a visitor. Play the preview and check the offers on your phone. If you see the code as text, switch the block to HTML. Your site must allow embedded players (iframes).</li></ol>
      <p>You can send the same code to a festival, a cinema or a publication for their own site. Your film stays in your storage account. Each player handles its own checkout, even when several filmmakers share a page.</p>
    </section>
    <section id="getting-started"><h2>How do I get started?</h2>
      <p>The pilot is invite-only. Open the workspace address from your invitation and choose <strong>Sign in</strong>. Enter your invited email address and open the single-use link from Stream. Connect your storage in Settings, then add a film in the Dashboard. You can upload it and watch a private preview before connecting Stripe. The pilot uses test cards. Your Cloudflare account uses real storage.</p>
    </section>
    <section id="storage"><h2>How do I connect my storage?</h2>
      <p>Open <strong>Settings → Storage</strong>. Sign in to Cloudflare or create an account and activate R2. Choose a private bucket for your films, or create one using Standard storage. In its settings, keep the public development URL disabled and custom domains disconnected. Copy the bucket’s dashboard address into Stream. <a href="#storage-pricing">What will storage cost?</a></p>
      <p>Stream opens Cloudflare’s token form for the account that owns your bucket. Choose <strong>Create an account token</strong> if you manage the account, or <strong>Create a user token</strong> if someone gave you access. Select <strong>Object Read &amp; Write</strong>, change the scope to <strong>Apply to specific buckets only</strong> and select just your film bucket. Paste the token value into Stream, or use your existing access key pair. Stream checks access to the bucket. You confirm the full permission scope in Cloudflare. <a href="https://developers.cloudflare.com/r2/api/tokens/">Cloudflare’s R2 token guide</a></p>
      <p>To rotate a key, choose <strong>Replace R2 key</strong> in Storage. The link opens Cloudflare for the same bucket’s account. Once Stream accepts it, you can revoke the old key in Cloudflare if nothing else uses it. Choose <strong>Use a different bucket</strong> for future uploads. Keep earlier buckets and their keys available for films already using them.</p>
    </section>
    <section id="payments"><h2>When can I start selling?</h2>
      <p>Connect Stripe and finish verification before you publish a paid film or program. In the pilot you can try checkout and transfers with test cards. No money reaches a bank account. <a href="#stripe-fees">What are the fees?</a> · <a href="#payouts">How do payouts work?</a> · <a href="#countries">Can I join from my country?</a></p>
      <p>In <strong>Settings → Payments</strong>, choose the new or existing account option. Enter identity and bank details directly on Stripe. Depending on your account, you can connect it or reuse verified details for a new one. Return to Stream and choose <strong>Check Stripe status</strong> to see whether anything is missing. <a href="https://docs.stripe.com/connect/hosted-onboarding">Stripe’s onboarding guide</a></p>
      <p>To change accounts, choose <strong>Reset Stripe connection</strong> and confirm the account shown. New sales pause until you reconnect. Your Stripe account stays open, earlier payments stay with their original account, and viewers keep their purchases and unexpired rentals.</p>
    </section>
    <section id="countries"><h2>Which countries can filmmakers join from?</h2>
      <p>Choose the country where you do business. Stripe uses it to verify your identity and bank details. <a href="https://docs.stripe.com/connect/connect-cross-border-payouts">Stripe’s supported regions</a></p>
      <details><summary>Countries available in the Stream pilot</summary><p>${countries}.</p></details>
    </section>
    <section id="payouts"><h2>Who owns my film and how do I get paid?</h2>
      <p>You keep your film rights and set the price. Confirm that you own the film or have permission to distribute it. Stream charges no royalty. Your film proceeds go to your connected Stripe balance after fees. An optional tip goes to Stream in the same payment.</p>
      <p>Film prices and Dashboard totals are in U.S. dollars. A transfer to your Stripe balance and a deposit to your bank are separate steps. In live mode, eligible accounts can choose weekly bank deposits in their Stripe Dashboard. Cross-border fees depend on the destination, and currency conversion can cost extra. <a href="https://docs.stripe.com/payouts">Bank payout schedules</a> · <a href="https://stripe.com/connect/pricing#payouts">Stripe payout pricing</a></p>
    </section>
    <section id="costs"><h2>What does it cost?</h2>
      <p>Stream is free. The optional tip starts at 10% of the film price. Viewers can change it or choose 0% to skip it.</p>
      <h3 id="stripe-fees">Stripe processing fees</h3>
      <p>Stripe’s standard U.S. online rate is 2.9% + 30¢ for a domestic card. The fee applies to the full payment, including tax and tip. For a $0.99 rental with a U.S. card and no tax or tip, the estimated fee is $0.33, leaving $0.66 for the filmmaker. International cards and custom pricing can change the fee. <a href="https://stripe.com/pricing?locale=en-US">Stripe pricing</a></p>
      <p>When checkout uses Stripe Tax Basic, Stripe lists a fee of 0.5% per transaction where Stream’s operator is registered to collect. Stream splits the actual fee between the film and the tip in proportion to their totals including tax. Viewers get access when payment clears. The Dashboard shows confirmed Stripe Tax fees after the operator reconciles Stripe’s itemized fee report. The filmmaker transfer waits for confirmed fees, which can take several days. Eligible New Mexico orders use Stream’s own calculation and skip the Stripe Tax Basic fee. Card processing still applies. <a href="https://stripe.com/tax/pricing">Stripe Tax pricing</a></p>
      <h3 id="storage-pricing">Cloudflare storage fees</h3>
      <p>R2 Standard includes 10 GB-month of storage per month across your Cloudflare account. That covers 10 GB kept for the entire month. Extra storage costs $0.015 per GB-month. With the full allowance available, 20 GB kept for a month costs about $0.15 in storage. R2 charges no internet egress fee for delivering your films. Infrequent Access has separate rates and no free allowance. <a href="https://developers.cloudflare.com/r2/pricing/">Cloudflare R2 pricing</a></p>
      <details><summary>Do uploads and views cost extra?</summary><p>Standard includes 1 million Class A requests (such as writes) and 10 million Class B requests (such as reads) per month. Beyond those allowances, Cloudflare bills $4.50 and $0.36 per million respectively, rounding up to the next billing unit. One viewing can involve several reads.</p></details>
    </section>
    <section id="tax"><h2>What tax will my viewers pay?</h2>
      <p>Viewers see their total before they pay. Any film tax is added to your price. Any tax on an optional tip is included in the tip amount they select. It all goes through as one payment.</p>
      <p>For eligible New Mexico orders, Stream uses the address where the viewer will watch to look up the local gross receipts tax rate. If the lookup cannot confirm a rate, checkout uses Stripe Tax with a viewing address. Elsewhere, Stripe Tax uses the viewer’s billing address. <a href="https://www.srca.nm.gov/parts/title03/03.001.0004.html">New Mexico reporting locations</a></p>
      <p>The pilot treats Stream’s operator as the marketplace provider and the tip as taxable at the film’s rate in New Mexico. In our Albuquerque test, a 99¢ rental with a 10¢ tip came to $1.17. That included 8¢ tax on the film and 1¢ within the tip. This example reflects the sandbox policy.</p>
      <p>Older pilot orders used a checkout with tax turned off. For new orders using marketplace checkout, a test charge can show zero tax where no sandbox registration applies. For live sales, Stream’s operator would need to arrange any required marketplace registrations, filing and remittance. Stripe Tax Basic calculates checkout tax. A sandbox registration creates no live registration. <a href="https://docs.stripe.com/tax/connect">Stripe Tax for marketplaces</a> · <a href="https://docs.stripe.com/tax/testing">Testing Stripe Tax</a></p>
    </section>
    <section><h2>What can I upload?</h2>
      <p>Upload a film you own or have permission to distribute. It can be an MP4, MOV or MKV file, up to 10 GB and four hours long. Stream reads H.264, H.265 (also called HEVC), AV1 and VP9 video.</p>
      <p>After you connect your private Cloudflare bucket, you can upload the film and its thumbnail right from Stream, or choose a film already in the bucket. The original stays in your account. For a thumbnail, use a JPEG, PNG or WebP up to 8 MB. We recommend 1920 × 1080 pixels.</p>
    </section>
    <section><h2>Can I watermark a rental screener?</h2>
      <p>Yes. In Prices and playback for a film or program, turn on <strong>Rental screener watermark</strong>. A short, anonymous rental reference appears in an upper corner for four seconds each minute. It travels with the video during playback and uses no viewer name or email address. Previews, purchases and original downloads keep their usual picture.</p>
    </section>
    <section><h2>Can viewers turn subtitles on?</h2>
      <p>Yes. If the film has subtitles, tap or move over the video to show its controls. Choose the captions button to pick a language or turn subtitles off. Stream supports embedded text subtitles and DVD or Blu-ray picture subtitles. Check the private preview for the tracks available in your file.</p>
    </section>
    <section id="tv"><h2>Can I watch a rental on my TV?</h2>
      <p>Start your film or program rental on the same Wi-Fi network as your TV. In Safari, choose <strong>AirPlay</strong> in the video controls. In Opera and other browsers, choose <strong>Play on TV</strong>. The devices you see depend on your browser. If your AirPlay TV isn’t listed, open <strong>Watch on another device</strong> and use your private rental link in Safari. For programs, use Previous title and Next title in the Stream player. Your caption language carries over to each title that offers it. You can keep watching until the original rental ends.</p>
      <h3>What should I export for TV viewing?</h3>
      <p>For the widest compatibility, export an <strong>MP4 with H.264 video and stereo AAC-LC audio</strong>. Use standard dynamic range (SDR), 8-bit color and up to 1080p at 24, 25 or 30 frames per second. Keep your film’s original frame rate if it’s one of those.</p>
      <p>You can also upload HEVC, AV1 or VP9. Stream prepares H.264 video for the rental, so the TV doesn’t need to read your original file. When Stream converts a film, the viewing copy is up to 720p at 24 frames per second. Viewers who buy a download receive the original. Before a screening, try a rental on the intended TV and check the picture, sound and any captions.</p>
    </section>
    <section><h2>Can I keep watching in a floating window?</h2>
      <p>Start the film, then choose the picture-in-picture button on the video. It appears when your browser, device and the site hosting the player allow it.</p>
    </section>
    <section><h2>What’s the difference between renting and buying?</h2>
      <p>A rental lets someone watch for the time you choose, from one hour to 30 days. Their time starts when they pay. Buying lets them watch and download the original file. You can offer either option or both. Sales are final.</p>
      <p>You can offer up to 180 seconds (3 minutes) for free. Leave at least one full second of the film after the preview. For a program, use the length of the video you chose for the preview. The usual default is 10 seconds. Choose zero to show the offers immediately.</p>
    </section>
    <section><h2>How do I offer a double feature or a program of shorts?</h2>
      <p>Once you’ve saved two films, choose <strong>Create program</strong> in the Programs section of your Dashboard. Pick at least two of your films, put them in screening order, and add an opening or closing video if you like. Choose the program image, preview and price, then publish and copy its embed code. Opening and closing videos you upload for a program are managed in its editor.</p>
      <p>Viewers pay once in the player and can move between titles with Previous title and Next title. The player remembers their caption choice when a matching track is available. One rental window covers the lineup. A purchase includes the original videos, in order, in a ZIP. After editing prices or the lineup, choose <strong>Publish changes</strong> to update the public embed. Earlier buyers keep their edition.</p>
    </section>
    <section><h2>Can a program save on card fees?</h2>
      <p>Yes, when the same viewer would otherwise pay for each film separately. Two separate $2 rentals cost about 72¢ in card fees at Stripe’s standard U.S. domestic card rate. One $4 double feature costs about 42¢, leaving about 30¢ more for the filmmaker at the same price. This example assumes no tax or tip. Your actual fees depend on the payment and your pricing. <a href="https://stripe.com/pricing?locale=en-US">Stripe pricing</a></p>
    </section>
    <section><h2>Can someone save a rental?</h2>
      <p>Stream delivers rentals through a private player. Your bucket address stays private. Someone who can watch a film can still record their screen. Buyers get a download button.</p>
    </section>
    <section><h2>How do I watch again or switch devices?</h2>
      <p>Save the private access link after checkout. Open it on your other device and keep it private. If email recovery is available, choose <strong>Restore access</strong> in the player and enter the email you used to pay. A rental ends at the same time on every device.</p>
    </section>
    <section id="dashboard-analytics"><h2>What do the numbers in my dashboard mean?</h2>
      <p>The first row shows paid plays, average watch time, rentals, purchases and net revenue. The <strong>Viewing and sales breakdown</strong> below it shows preview starts, gross revenue, fees and tax.</p>
      <p><strong>Avg. watch time</strong> is the total time people spent watching divided by the number of paid title plays measured since timing began. Free previews and older plays are excluded. A dash means there are no timed plays yet. Pauses, buffering and seeking past footage add no time. Watching a section again adds time. Closing a player before it sends its last update can leave a partial measurement.</p>
      <p>Renting or buying a program counts as one sale. If that viewer starts two titles, the program records two paid plays. Each film shows its own plays, including those from programs. The program also shows plays across its lineup, including opening and closing videos. The Overview counts each play once. Older plays still count for each film. Stream began tracking which program a film was watched in when watch timing started.</p>
      <p><strong>Revenue</strong> adds up the prices viewers paid for films and programs before fees or payment adjustments. Tips and tax are tracked separately. <strong>Net Revenue</strong> subtracts card fees, the filmmaker’s share of confirmed Stripe Tax fees, and any payment adjustments recorded by Stripe. When an adjustment affects your earnings, the breakdown shows the calculation. <strong>Tax charged</strong> shows tax at the time of sale, including tax within a tip.</p>
      <p><strong>Stripe fees</strong> shows the card processing fees used to calculate net revenue. For each payment, Stream uses the fee Stripe reports. Until it arrives, Stream estimates 2.9% plus 30¢ on the full charge, including any tip and tax. Stream checks for final fees automatically. The info button shows how much is confirmed and how much is still estimated. <strong>Stripe Tax fees</strong> shows the filmmaker’s share of the confirmed fee for calculating tax. Pending means Stream is waiting for fee confirmation.</p>
      <p>All Dashboard amounts are in U.S. dollars. The pilot shows test payments. For bank payouts and adjustments to disputed payments, check your Stripe Dashboard. <a href="#stripe-fees">More about Stripe fees</a> · <a href="#payouts">How payouts work</a></p>
    </section>
    <section><h2>What if I take my film or program offline?</h2>
      <p>Unpublishing stops free previews and new sales. People who bought the film or have time left on a rental can still watch. Keep the original files in your bucket so their access keeps working. Publishing a new lineup preserves the edition earlier viewers paid for.</p>
    </section>`;
}
