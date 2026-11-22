// Keep this edition available at its original URL when adding future agreements.
export const agreementVersion = 'pilot-v1';
export const agreementPath = '/setup/agreement/' + agreementVersion;

const editions = {
  test: {version: agreementVersion, path: agreementPath},
  live: {version: 'pilot-live-v1', path: '/setup/agreement/pilot-live-v1'}
};

export function agreementFor(mode) {
  if (!Object.hasOwn(editions, mode)) throw new Error('Unknown agreement edition.');
  return editions[mode];
}

export function agreementModeForPath(path) {
  return Object.keys(editions).find(mode => editions[mode].path === path);
}

export function renderFilmmakerAgreement(mode = 'test') {
  const live = mode === 'live';
  return `<article class="filmmaker-agreement">
    <header><h1>Filmmaker agreement</h1><p class="hint">${live ? 'Live pilot edition 1' : 'Pilot edition 1'} · November 21, 2026</p></header>
    <p>This is the agreement between you and Stream, operated by Dust Wave, when you open a filmmaker workspace. If you’re signing up for a company or a filmmaking team, you confirm you can agree on its behalf.</p>
    <section><h2>Your film stays yours</h2><p>You and your collaborators keep your rights. Stream takes no ownership, distribution rights, exclusivity or royalties. You choose where to embed your work, what viewers can rent or download, and at what price. You can distribute it elsewhere at any time.</p></section>
    <section><h2>Only share work you can offer</h2><p>Before you upload or publish, make sure you have permission for everything you include, such as footage, music, performances, artwork and captions. Your permissions must cover the viewers who can reach your embed and the uses you offer, including downloads if you enable them. Use Stream lawfully and describe your offer accurately.</p></section>
    <section><h2>What you ask Stream to do</h2><p>When you connect storage, upload a file or publish a player, you instruct Stream and its service providers to carry out those choices. This includes reading files from your private bucket, preparing previews and playback, displaying the details you supply, and delivering rentals and downloads on your behalf.</p></section>
    ${live ? `<section><h2>Payments and fees</h2><p>When you publish a paid offer, viewers who check out are charged real money. You set the price in U.S. dollars and receive the film proceeds in your connected Stripe account after card fees, your share of applicable Stripe Tax fees and any payment adjustments. Stream receives any optional tip. Transfers can take several days while Stripe confirms fees. Your bank payout follows your Stripe schedule. You pay Cloudflare for any storage or usage above your allowance. The <a href="/faq#costs">FAQ explains fees</a> and <a href="/faq#tax">how tax works</a>.</p><p>Stream handles marketplace transaction tax where it is responsible for collection. You remain responsible for your own income taxes and any obligations applicable to your business.</p></section>` :
    '<section><h2>Money during the pilot</h2><p>Checkout uses Stripe test payments. No real money moves to you or Stream. Cloudflare storage and usage are real and billed to your account. You set the film price. An optional viewer tip is for Stream. The <a href="/faq#costs">FAQ explains fees</a> and <a href="/faq#tax">how tax works</a>.</p></section>'}
    <section><h2>Your account and your viewers</h2><p>Keep your email links and storage credentials private. Stream uses account, order and playback information to run sign-in, deliver access and show you analytics. Cloudflare checks the sign-up and sign-in forms, Resend delivers access emails, and Stripe handles checkout. Only use viewer information you receive to fulfill the viewing offer, unless the viewer separately agrees to another use.</p></section>
    <section><h2>Taking a film offline</h2><p>You can unpublish a film or program at any time. That ends new sales and previews. Keep its original files and storage connection available for viewers who already bought it or have time left on a rental. A download already delivered stays with the buyer.</p></section>
    <section><h2>If something goes wrong</h2><p>Keep a separate backup of your work. Pilot features can change or go offline, and someone watching a film may be able to record it. Stream may pause access to address a rights complaint, account misuse, or a legal or security issue. This agreement preserves any rights the law gives you that cannot be waived.</p>${live ? '<p>For help with an order or a rights complaint, email <a href="mailto:info@dustwave.xyz">Stream support</a> with the player address and a description of the issue.</p>' : ''}</section>
  </article>`;
}
