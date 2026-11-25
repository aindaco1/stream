import { examplePath } from './player-page.js';
import { workspacePage } from './workspace-page.js';
import { signUpPath } from './workspace-access.js';

export function filmmakerHome() {
  return workspacePage('Rent and sell independent films on your own site', null, `
    <section class="home-lead" aria-labelledby="home-title">
      <div class="home-pitch">
        <h1 id="home-title">Rent your film <em>on your own site.</em></h1>
        <p>Stream is an open-source player for independent filmmakers. When someone asks where to watch after a screening, <em>send them to your own page.</em> They can play a preview, rent the film or buy a download right there.</p>
        <a class="primary-link" data-home-account href="${signUpPath}">Sign up for free</a>
      </div>
      <figure class="home-excerpt">
        <figcaption><strong>Try the player</strong> Play ten seconds of San Francisco in 1906, then explore the rental and download offers. You can try both without paying.</figcaption>
        <iframe src="${examplePath}" title="Example Stream player for A Trip Down Market Street" width="640" height="660" allowfullscreen></iframe>
        <a class="excerpt-source" href="https://www.loc.gov/item/00694408/">Watch the complete film at the Library of Congress</a>
      </figure>
    </section>
    <section class="home-notes" aria-label="Releasing a film with Stream">
      <div><h2>Start with one film.</h2>
        <p>Give an older film a new rental link, or put together a program of shorts for a festival. You choose the price and paste the player into your site or a partner's. You keep the rights. We never train AI on your films.</p>
        <p>Your original lives in your own Cloudflare storage. We'll walk you through connecting it. You can try a private preview and connect Stripe when you're ready to sell.</p>
        <a href="/faq#embed">How to put a film on your site</a>
      </div>
      <div><h2>What happens to a $5 rental?</h2>
        <p>Stream takes $0 of the film price. There's no subscription or listing fee. You receive the proceeds after Stripe's fees, and Cloudflare bills you for storage beyond its free allowance.</p>
        <p>Viewers can leave Stream a tip to help keep it running. They can also choose zero and watch the same film.</p>
        <a href="/faq#costs">See fees and payout examples</a>
      </div>
    </section>`, { landing: true });
}
