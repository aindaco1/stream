import { workspacePage } from './workspace-page.js';
import { signInPath, signUpPath } from './workspace-access.js';

export function filmmakerHome() {
  return workspacePage('Rent and sell independent films on your own site', null, `
    <section class="home-lead" aria-labelledby="home-title">
      <div class="home-pitch">
        <h1 id="home-title">Rent your film <em>on your own site.</em></h1>
        <p>Stream is an open-source player for independent filmmakers. When someone asks where to watch after a screening, send them to your own page. They can play a preview, rent the film or buy a download right there.</p>
        <a class="primary-link" href="${signUpPath}">Sign up for free</a>
      </div>
      <figure class="home-excerpt">
        <div class="film-gate">
          <video controls playsinline preload="none" width="720" height="540"
            poster="/market-street-still.webp" src="/market-street-excerpt.mp4"
            aria-labelledby="excerpt-title" aria-describedby="excerpt-info excerpt-scene">
            <a href="/market-street-excerpt.mp4">Watch the silent excerpt</a>
          </video>
          <button class="excerpt-play" type="button" hidden data-play-excerpt><span aria-hidden="true">▶</span> Play excerpt</button>
        </div>
        <figcaption>
          <cite id="excerpt-title">A Trip Down Market Street</cite>
          <span id="excerpt-info">Miles Brothers, 1906 · 10-second silent excerpt</span>
          <span id="excerpt-scene" hidden>A streetcar crosses the tracks in front of the camera in San Francisco.</span>
          <a href="https://www.loc.gov/item/00694408/">Library of Congress</a>
        </figcaption>
      </figure>
    </section>
    <section class="home-notes" aria-label="Releasing a film with Stream">
      <div><h2>Start with one film.</h2>
        <p>Give an older film a new rental link, or put together a program of shorts for a festival. You choose the price and paste the player into your site or a partner's. You keep the rights. We never train AI on your films.</p>
        <p>Your original lives in your own Cloudflare R2 storage. We'll walk you through connecting it. You can try a private preview and connect Stripe when you're ready to sell.</p>
        <a href="/faq#embed">How to put a film on your site</a>
      </div>
      <div><h2>What happens to a $5 rental?</h2>
        <p>Stream takes $0 of the film price. There's no subscription or listing fee. You receive the proceeds after Stripe's fees, and Cloudflare bills you for storage beyond its free allowance.</p>
        <p>Viewers can leave Stream a tip to help keep it running. They can also choose zero and watch the same film.</p>
        <a href="/faq#costs">See fees and payout examples</a>
      </div>
    </section>`, { landing: true, guestSignIn: signInPath });
}
