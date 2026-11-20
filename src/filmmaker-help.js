const pricing = {
  stripe: {
    heading: 'Stripe processing fees',
    summary: 'Stripe’s standard U.S. rate for a successful online payment with a domestic card is 2.9% + 30¢. Your country, card type, currency and any custom pricing can change the fee.',
    example: 'On a $0.99 U.S. rental at that rate, the fee is about $0.33, leaving $0.66 before any taxes or other charges.',
    url: 'https://stripe.com/us/pricing',
    link: 'Stripe pricing'
  },
  r2: {
    heading: 'Cloudflare R2 storage fees',
    summary: 'Cloudflare’s Standard tier includes 10 GB of storage free for a full month, shared across your account. Additional storage costs $0.015 per GB-month. Cloudflare charges for reads and writes above its monthly allowances. Sending video to viewers is free of bandwidth charges.',
    example: 'For example, storing 20 GB for a full month costs about $0.15 for storage if your account has the full allowance available.',
    operations: 'The monthly allowance also includes 1 million Class A operations (such as writes) and 10 million Class B operations (such as reads). Additional operations cost $4.50 and $0.36 per million respectively, rounded up to whole billing units. One viewing can involve several reads. The free tier applies only to Standard storage.',
    url: 'https://developers.cloudflare.com/r2/pricing/',
    link: 'Cloudflare R2 pricing'
  }
};

const platformCosts = 'Stream is free to use and takes no cut of rentals or purchases. Your connected Stripe account receives the payment, and Cloudflare bills your account for storage and usage.';
const sandbox = 'Viewer checkout currently runs in a Stripe sandbox. Payments are simulated. Your Cloudflare bucket is real and its normal usage charges apply.';

function feeCopy(provider, expanded = false) {
  const { summary, example, operations, url, link } = pricing[provider];
  return `<p>${summary} <a href="${url}">${link}</a></p>${expanded ? `<p>${example}</p>` : ''}${expanded && operations ? `<p>${operations}</p>` : ''}`;
}

export function renderSetupCosts(provider) {
  if (!Object.hasOwn(pricing, provider)) throw new TypeError('Unknown setup cost provider.');
  const pilot = provider === 'stripe' ? 'The current pilot simulates payments.' : 'These charges apply to your bucket during the pilot.';
  return `<div class="provider-costs"><h3>${pricing[provider].heading}</h3>${feeCopy(provider)}<p>${pilot}</p></div>`;
}

export function renderFilmmakerSettings() {
  return `<h1>Settings</h1>
    <p>${platformCosts}</p><p>${sandbox}</p>
    <section><h2>${pricing.stripe.heading}</h2>
      ${feeCopy('stripe', true)}
      <p>See each charge and its net amount in your Stripe Dashboard. Stream’s dashboard shows gross test payments.</p>
      <p><a href="/setup#payments">Manage Stripe connection</a></p>
    </section>
    <section><h2>${pricing.r2.heading}</h2>
      ${feeCopy('r2', true)}
      <p><a href="/setup#storage">Manage R2 connection</a></p>
    </section>
    <section><h2>Viewer purchases</h2>
      <p>Sales are final. Set each film’s prices, rental duration and free preview in your dashboard.</p>
      <p><a href="/setup/dashboard#films">Manage films</a></p>
    </section>`;
}

export function renderFilmmakerFaq() {
  return `<h1>Filmmaker FAQ</h1>
    <p>Stream is an open-source player for filmmakers who want to rent or sell a film from their own website. <a href="https://github.com/aindaco1/stream">Stream on GitHub</a></p>
    <section><h2>Can I use Stream today?</h2>
      <p>The pilot is invite-only. ${sandbox}</p>
      <p>You need distribution rights to your film, a private Cloudflare R2 bucket and a Stripe account eligible to accept card payments and payouts. Setup guides you through creating accounts or using existing ones. Stripe determines eligibility for your business and country. <a href="https://stripe.com/global">Countries supported by Stripe</a></p>
    </section>
    <section id="costs"><h2>What does it cost?</h2>
      <p>${platformCosts}</p>
      <h3>${pricing.stripe.heading}</h3>${feeCopy('stripe', true)}
      <h3>${pricing.r2.heading}</h3>${feeCopy('r2', true)}
    </section>
    <section><h2>Where do I put my film?</h2>
      <p>Stream currently supports Cloudflare R2. Your original stays in your private bucket. Confirm your distribution rights for each film, then upload it or select a file already in the bucket. To upload films and thumbnails through Stream, authorize an encrypted credential scoped to that one bucket.</p>
      <p>Use a seekable MP4 with H.264 Baseline video and optional AAC-LC audio, up to 1 GiB and four hours. Start with a keyframe and keep later keyframes at most 12 seconds apart.</p>
    </section>
    <section><h2>How do previews, rentals and purchases work?</h2>
      <p>Choose a free preview from 0 to 30 seconds. The default is 10 seconds. Offer a streaming rental, a one-time purchase, or both at your own USD prices. The rental clock starts at purchase and runs for the 1 to 720 hours you set. Buyers can stream and download the original MP4. Sales are final.</p>
    </section>
    <section><h2>Where can I embed the player?</h2>
      <p>Publish the film, copy its embed code from your dashboard and paste it into any page that allows iframe embeds and payments. Add an optional thumbnail, synopsis, credits or message from the dashboard. Multiple films can share a page. Each player handles its own preview, checkout and paid access.</p>
    </section>
    <section><h2>Can someone copy a rental?</h2>
      <p>The player keeps your R2 address private and checks time-limited access before serving encrypted rental video. A viewer with playback access can still record the screen.</p>
    </section>
    <section><h2>How does a viewer watch again?</h2>
      <p>Viewers can save the private access link from the player and open it on another device. Anyone with that link can use it. When email recovery is available, viewers can choose <strong>Restore access</strong> and use the email address from checkout. A rental keeps its original end time.</p>
    </section>
    <section><h2>What can I see in my dashboard?</h2>
      <p>See preview starts, paid plays, rentals, purchases and gross test payments for each film and across your films. Stripe shows fees and net amounts for individual payments.</p>
    </section>
    <section><h2>What happens if I unpublish?</h2>
      <p>Unpublishing stops public previews and new sales. Earlier purchases and unexpired rentals keep their original terms. Keep the same file accessible in your bucket so those viewers can watch.</p>
    </section>`;
}
