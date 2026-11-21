import { payoutCountryOptions } from './payout-countries.js';

export const firstSale = 'You can upload a film and watch a private preview before connecting Stripe. To publish and get paid for rentals or purchases, first connect your Stripe account and finish verification.';

const proceeds = 'You keep your film rights. Rentals and purchases are your sales. Stream sends your proceeds to your connected Stripe account after fees. In your <a href="https://dashboard.stripe.com/settings/payouts">Stripe Dashboard</a>, you can choose weekly bank deposits if your account offers them. Viewers can add an optional tip for Dust Wave in the same payment.';

function payoutCountries() {
  const names = payoutCountryOptions.map(country => country.label).join(', ');
  return `<p>The pilot is open to filmmakers in the U.S., Canada, the UK, Switzerland and the European countries listed below. Choose the country where you do business. Stripe guides you through identity and bank verification there. You can sign in to reuse eligible details from an existing Stripe account.</p>
    <details><summary>Which countries can filmmakers join from?</summary><p>${names}.</p></details>
    <p>Film prices and dashboard totals are in U.S. dollars. Stripe shows the payout currencies available for your bank account. Cross-border payout fees start at 0.25%, and currency conversion can cost extra. <a href="https://stripe.com/connect/pricing#payouts">Stripe payout pricing</a></p>`;
}

const pricing = {
  stripe: {
    heading: 'Stripe processing fees',
    summary: 'For a successful online payment with a U.S. domestic card, Stripe’s standard U.S. rate is 2.9% + 30¢. Your country, the card and any custom pricing can change the fee.',
    example: 'For a U.S. filmmaker’s $0.99 rental paid with a U.S. card, the estimated fee is $0.33 and the filmmaker receives $0.66 before any tax or tip.',
    url: 'https://stripe.com/us/pricing', link: 'Stripe pricing'
  },
  r2: {
    heading: 'Cloudflare storage fees',
    summary: 'Cloudflare includes 10 GB of storage free each month across your account on its Standard plan. Extra storage costs $0.015 per GB-month. There’s no bandwidth charge for sending a film to viewers.',
    example: 'If you keep 20 GB of films online for the whole month and have the full free allowance available, storage costs about $0.15.',
    details: 'Cloudflare also counts requests to store or read files. The Standard plan includes 1 million Class A requests (such as uploads) and 10 million Class B requests (such as reads) each month. Additional requests cost $4.50 and $0.36 per million, respectively. A single viewing can involve several reads.',
    url: 'https://developers.cloudflare.com/r2/pricing/', link: 'Cloudflare R2 pricing'
  }
};

function feeCopy(provider, expanded = false) {
  const { summary, example, details, url, link } = pricing[provider];
  const taxPricing = provider === 'stripe' ? '<p>When Stream uses Stripe Tax, Stripe lists a separate Tax Basic fee of 0.5% of the full checkout total where Dust Wave is registered to collect. You cover the share for the film, and Dust Wave covers the share for the tip. We use each line’s total including tax. Your viewer gets access as soon as payment clears. We send your transfer once the actual fees are confirmed, which can take several days. Stream calculates tax itself for eligible New Mexico orders, which saves that fee. The card processing fee still applies. <a href="https://stripe.com/tax/pricing">Stripe Tax pricing</a></p>' : '';
  return `<p>${summary} <a href="${url}">${link}</a></p>${taxPricing}${expanded ? `<p>${example}</p>` : ''}
    ${expanded && details ? `<details><summary>How does Cloudflare count requests?</summary><p>${details}</p></details>` : ''}`;
}

export function renderSetupCosts(provider) {
  if (!Object.hasOwn(pricing, provider)) throw new TypeError('Unknown setup cost provider.');
  const pilot = provider === 'stripe' ? 'Payments in the pilot use test cards. Payments and filmmaker transfers run in the Stripe sandbox.' : 'Your bucket is billed normally during the pilot.';
  const payouts = provider === 'stripe' ? `<h3>Getting paid</h3><p>${proceeds}</p>${payoutCountries()}` : '';
  return `<div class="provider-costs"><p>${pilot}</p>${payouts}<h3>${pricing[provider].heading}</h3>${feeCopy(provider)}</div>`;
}

export function renderFilmmakerFaq() {
  return `<h1>FAQ</h1>
    <p>Stream lets filmmakers rent or sell a film from a player on their own website. Viewers pay and watch in the same place. <a href="https://github.com/aindaco1/stream">Stream on GitHub</a></p>
    <section><h2>How do I get started?</h2>
      <p>The pilot is invite-only. Open your invitation and go to Settings. Start in Storage to connect your Cloudflare bucket. Then open Payments to connect the Stripe account where you want to get paid.</p>
      <p>The pilot uses test cards, so no money changes hands at checkout. Your Cloudflare account still uses real storage.</p>
    </section>
    <section><h2>When can I start selling?</h2>
      <p>${firstSale} Once you publish in the pilot, viewers can try a rental or purchase with a test card.</p>
    </section>
    <section><h2>Can I use Stream outside the United States?</h2>
      ${payoutCountries()}
    </section>
    <section><h2>Who owns my film and receives the sale?</h2>
      <p>${proceeds} You set the price and confirm that you own the film or have permission to distribute it.</p>
    </section>
    <section id="costs"><h2>What does it cost?</h2>
      <p>Stream is free. The tip starts at 10% of the film price. Viewers can change it or choose 0% to skip it. The processing fee applies to the full charge, including tax and tip.</p>
      <h3>${pricing.stripe.heading}</h3>${feeCopy('stripe', true)}
      <h3>${pricing.r2.heading}</h3>${feeCopy('r2', true)}
    </section>
    <section><h2>What tax will my viewers pay?</h2>
      <p>Viewers see the total before they pay. Any film tax is added to your price. Any tax on an optional tip is included in the tip amount the viewer selects. It all goes through as one payment.</p>
      <p>In New Mexico, Stream looks up the local gross receipts tax rate using the address where the viewer will watch. If Stream can’t match the address, Stripe asks the viewer to confirm or correct it. Elsewhere, Stripe Tax uses the viewer’s billing address.</p>
      <p>For example, in our downtown Albuquerque test, a 99¢ rental with a 10¢ tip came to $1.17. The viewer paid 8¢ in tax on the film, and 1¢ of the tip went toward tax. Dust Wave’s pilot treats the tip as taxable at the film’s rate.</p>
      <p>Dust Wave handles checkout tax as the marketplace in the pilot. A test charge can show zero tax where no sandbox registration applies. Dust Wave is responsible for registering and filing wherever it handles marketplace tax. This includes taxable New Mexico film sales even when the viewer leaves no tip. <a href="https://docs.stripe.com/tax/connect">Stripe Tax for platforms and marketplaces</a> · <a href="https://docs.stripe.com/tax/testing">Testing Stripe Tax</a></p>
    </section>
    <section><h2>What can I upload?</h2>
      <p>Upload a film you own or have permission to distribute. It can be an MP4, MOV or MKV file, up to 10 GB and four hours long. Stream reads H.264, H.265 (also called HEVC), AV1 and VP9 video.</p>
      <p>After you connect your private Cloudflare bucket, you can upload the film and its thumbnail right from Stream, or choose a film already in the bucket. The original stays in your account.</p>
    </section>
    <section><h2>Can viewers turn subtitles on?</h2>
      <p>Yes. If the film has subtitles, tap or move over the video to show its controls. Choose the captions button to pick a language or turn subtitles off. Stream supports text subtitles and picture subtitles such as the ones on DVDs and Blu-rays.</p>
    </section>
    <section><h2>Can I keep watching in a floating window?</h2>
      <p>Start the film, then choose the picture-in-picture button on the video. It appears when your browser, device and the site hosting the player allow it.</p>
    </section>
    <section><h2>What’s the difference between renting and buying?</h2>
      <p>A rental lets someone watch for the time you choose, from one hour to 30 days. Their time starts when they pay. Buying lets them watch and download the original file. You can offer either option or both. Sales are final.</p>
      <p>You can give people up to 30 seconds to watch for free. The default is 10 seconds. Choose zero to show the offers immediately.</p>
    </section>
    <section><h2>How do I put a film on my site?</h2>
      <p>Open your published film in the Dashboard. Choose the details you want alongside the player and check the live preview. You can include a synopsis, credits or a personal message. Copy the embed code and paste it into your site. Each film has its own checkout, even when several share a page.</p>
    </section>
    <section><h2>Can someone save a rental?</h2>
      <p>Rentals use a private video stream, and viewers never see your Cloudflare link. Someone who can watch a film can still record their screen. Buyers get a download button.</p>
    </section>
    <section><h2>How do I watch again or switch devices?</h2>
      <p>Save the private access link after checkout. Open it on your other device and keep it private. If email recovery is available, choose <strong>Restore access</strong> in the player and enter the email you used to pay. A rental ends at the same time on every device.</p>
    </section>
    <section><h2>What do the numbers in my dashboard mean?</h2>
      <p>See preview starts, paid plays, rentals and purchases for each film. Repeat plays count. Revenue shows film prices before refunds. Tax and optional tips are tracked separately. Net revenue deducts card fees, your share of confirmed Stripe Tax fees, and recorded refunds up to the film price. The Dashboard marks payments awaiting a tax fee.</p>
    </section>
    <section><h2>What if I take my film offline?</h2>
      <p>Unpublishing stops free previews and new sales. People who bought the film or have time left on a rental can still watch. Keep the original in your bucket so their access keeps working.</p>
    </section>`;
}
