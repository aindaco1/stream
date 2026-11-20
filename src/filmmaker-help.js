const pricing = {
  stripe: {
    heading: 'Stripe processing fees',
    summary: 'For a successful online payment with a U.S. domestic card, Stripe’s standard U.S. rate is 2.9% + 30¢. Your country, the card and any custom pricing can change the fee.',
    example: 'On a $0.99 rental with no tax or tip, the estimated fee is $0.33 and the filmmaker receives $0.66.',
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
  const taxPricing = provider === 'stripe' ? '<p>When Stream uses Stripe Tax, Stripe lists a separate Tax Basic fee of 0.5% of the full checkout total where Dust Wave is registered to collect. Dust Wave covers that fee. Stream calculates tax itself for eligible New Mexico orders, which saves that fee. The card processing fee still applies. <a href="https://stripe.com/tax/pricing">Stripe Tax pricing</a></p>' : '';
  return `<p>${summary} <a href="${url}">${link}</a></p>${taxPricing}${expanded ? `<p>${example}</p>` : ''}
    ${expanded && details ? `<details><summary>How does Cloudflare count requests?</summary><p>${details}</p></details>` : ''}`;
}

export function renderSetupCosts(provider) {
  if (!Object.hasOwn(pricing, provider)) throw new TypeError('Unknown setup cost provider.');
  const pilot = provider === 'stripe' ? 'Payments in the pilot use test cards. Payments and filmmaker transfers run in the Stripe sandbox.' : 'Your bucket is billed normally during the pilot.';
  return `<div class="provider-costs"><h3>${pricing[provider].heading}</h3>${feeCopy(provider)}<p>${pilot}</p></div>`;
}

export function renderFilmmakerFaq() {
  return `<h1>FAQ</h1>
    <p>Stream lets filmmakers rent or sell a film from a player on their own website. Viewers pay and watch in the same place. <a href="https://github.com/aindaco1/stream">Stream on GitHub</a></p>
    <section><h2>How do I get started?</h2>
      <p>The pilot is invite-only. Open your invitation and go to Settings. You’ll connect Stripe to get paid and Cloudflare to store your film. You can use accounts you already have. <a href="https://stripe.com/global">Where Stripe is available</a></p>
      <p>The pilot uses test cards, so no money changes hands at checkout. Your Cloudflare account still uses real storage.</p>
    </section>
    <section id="costs"><h2>What does it cost?</h2>
      <p>Stream is free. You set the film price. For new marketplace orders, Dust Wave transfers the film price less the verified card processing fee to your connected Stripe account. Viewers can add an optional tip for Dust Wave when they rent or buy. The tip starts at 10% of the film price. Viewers can change it or choose 0% to skip it. The processing fee applies to the full charge, including tax and tip.</p>
      <h3>${pricing.stripe.heading}</h3>${feeCopy('stripe', true)}
      <h3>${pricing.r2.heading}</h3>${feeCopy('r2', true)}
    </section>
    <section><h2>How does checkout calculate tax?</h2>
      <p>For viewers watching in New Mexico, Stream can use their viewing address to look up the local gross receipts tax rate. Other locations use Stripe Tax at checkout. Applicable film tax is added to your price. Any tax on an optional tip is included in the tip amount the viewer chose. The viewer sees the total and pays once.</p>
      <p>The pilot tests Dust Wave as the marketplace responsible for collection. A test charge can show zero tax, for example when the product is exempt or the sandbox has no registration for the viewer’s location. Before live sales, Dust Wave needs to confirm its obligations, configure live registrations where required, and arrange filing and remittance. <a href="https://docs.stripe.com/tax/connect">Stripe Tax for platforms and marketplaces</a> · <a href="https://docs.stripe.com/tax/testing">Testing Stripe Tax</a></p>
    </section>
    <section><h2>What can I upload?</h2>
      <p>Upload a film you own or have permission to distribute. It can be an MP4, MOV or MKV file, up to 10 GB and four hours long. Stream reads H.264, H.265 (also called HEVC), AV1 and VP9 video.</p>
      <p>After you connect your private Cloudflare bucket, you can upload the film and its thumbnail right from Stream, or choose a film already in the bucket. The original stays in your account.</p>
    </section>
    <section><h2>Can viewers turn subtitles on?</h2>
      <p>Yes. Viewers can pick a language or choose Off in the player. Stream can use text subtitles and picture subtitles such as the ones on DVDs and Blu-rays. Include the tracks you want in the film you upload.</p>
    </section>
    <section><h2>What’s the difference between renting and buying?</h2>
      <p>A rental lets someone watch for the time you choose, from one hour to 30 days. Their time starts when they pay. Buying lets them watch and download the original file. You can offer either option or both. Sales are final.</p>
      <p>You can give people up to 30 seconds to watch for free. The default is 10 seconds. Choose zero to show the offers immediately.</p>
    </section>
    <section><h2>How do I put a film on my site?</h2>
      <p>Publish the film, then copy the embed code from your dashboard. Paste it into a page that accepts embedded players and payments. You can show your credits, a synopsis or a short message. Each film has its own checkout, even when several share a page.</p>
    </section>
    <section><h2>Can someone save a rental?</h2>
      <p>Rentals use a private video stream, and viewers never see your Cloudflare link. Someone who can watch a film can still record their screen. Buyers get a download button.</p>
    </section>
    <section><h2>How do I watch again or switch devices?</h2>
      <p>Save the private access link after checkout. Open it on your other device and keep it private. If email recovery is available, choose <strong>Restore access</strong> in the player and enter the email you used to pay. A rental ends at the same time on every device.</p>
    </section>
    <section><h2>What do the numbers in my dashboard mean?</h2>
      <p>See preview starts, paid plays, rentals and purchases for each film. Repeat plays count. Revenue shows film prices before refunds. Tax and optional tips are tracked separately. Net revenue deducts processing fees and recorded refunds up to the film price. When Stripe hasn’t reported a fee, Stream estimates it on the full charge.</p>
    </section>
    <section><h2>What if I take my film offline?</h2>
      <p>Unpublishing stops free previews and new sales. People who bought the film or have time left on a rental can still watch. Keep the original in your bucket so their access keeps working.</p>
    </section>`;
}
