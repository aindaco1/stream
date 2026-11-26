import { examplePath } from './example-checkout.js';
import { workspacePage } from './workspace-page.js';
import { signUpPath } from './workspace-access.js';

export function filmmakerHome() {
  return workspacePage('Rent and sell independent films on your own site', null, `
    <section class="home-lead" aria-labelledby="home-title">
      <div class="home-pitch">
        <h1 id="home-title">Rent your film <em>on your own site.</em></h1>
        <p>Stream is an <a href="https://github.com/aindaco1/stream">open-source player</a> for independent filmmakers. When someone asks where to watch after a screening, <em>send them to your own page.</em> They can <strong>play a preview, rent your film or buy a download</strong> right there.</p>
        <a class="primary-link" data-home-account href="${signUpPath}">Sign up for free</a>
      </div>
      <figure class="home-excerpt">
        <figcaption><strong>Try the player</strong> Ride down Market Street in 1906. Watch the ten-second preview, then use a <strong>Stripe test card</strong> to rent or buy the full film. No charge.</figcaption>
        <iframe src="${examplePath}" title="Example Stream player for A Trip Down Market Street" width="640" height="660" allow="payment; fullscreen; picture-in-picture" allowfullscreen></iframe>
        <a class="excerpt-source" href="https://www.loc.gov/item/00694408/">Watch the complete film at the Library of Congress</a>
      </figure>
    </section>
    <section class="home-notes" aria-label="Releasing a film with Stream">
      <div><h2>Start with one film.</h2>
        <p>Give an older film a new rental link, or put together a program of shorts for a festival. You choose the price and paste the player into your site or a partner's. <strong>You keep the rights.</strong> We never train AI on your films.</p>
        <p>Your original lives in <a href="/faq#storage">your own Cloudflare storage</a>. We'll walk you through connecting it. You can try a private preview and connect Stripe when you're ready to sell.</p>
        <a href="/faq#embed">How to put a film on your site</a>
      </div>
      <div><h2>What happens to a $5 rental?</h2>
        <p><strong>Stream takes $0 of the film price.</strong> There's no subscription or listing fee. You receive the proceeds after Stripe's fees, and Cloudflare bills you for storage beyond its free allowance.</p>
        <p>Viewers can leave Stream a tip to help keep it running. They can also choose <em>zero</em> and watch the same film.</p>
        <a href="/faq#costs">See fees and payout examples</a>
      </div>
    </section>
    <section class="home-notes" aria-label="Screeners and screenings">
      <div><h2>Send a rental screener.</h2>
        <p>Sending a film to a programmer or a critic? Turn on <a href="/faq#watermark">rental watermarking</a>. A small rental code changes position inside the picture and appears for <strong>four seconds each minute</strong>.</p>
        <p>Your viewer’s name and email stay private. The preview, purchased film and original download keep their clean picture.</p>
      </div>
      <div><h2>Make it a double feature.</h2>
        <p>Pair an early short with your new feature, or curate a whole festival block. Set the screening order, add a filmed introduction and give the audience <strong>one ticket for the whole program</strong>.</p>
        <p>Viewers can move between titles. Their caption language follows them when the next film has that track. <a href="/faq#programs">Build a program of films</a>.</p>
      </div>
    </section>
    <section class="home-notes" aria-label="Watching at home">
      <div><h2>Take the rental to the TV.</h2>
        <p>A viewer who rented on a laptop can open their <strong>private rental link</strong> on another device. In Safari, they can <a href="/faq#tv">send the film to an AirPlay TV</a> on the same Wi-Fi and settle in for the screening.</p>
      </div>
      <div><h2>Let viewers choose the subtitles.</h2>
        <p>Include subtitle tracks in your film and the player gives viewers a <strong>captions menu</strong>. They can choose a language or turn subtitles off as they watch. <a href="/faq#subtitles">See supported subtitle tracks</a>.</p>
      </div>
    </section>`, { landing: true });
}
