import { workspacePage } from './workspace-page.js';

export function privacyPage(options = {}) {
  return workspacePage('Privacy policy', null, `<article class="privacy-policy reference-content">
    <header><h1>Privacy policy</h1><p>Last updated November 25, 2026</p>
      <p>Dust Wave runs Stream from New Mexico. This policy covers streamyourfilm.com and the Stream player, including when you watch on a filmmaker’s site. The site around the player has its own privacy practices.</p></header>
    <section><h2>When you watch a film</h2>
      <p>You can play a preview without giving us your email. Like any video host, we receive the network and browser information needed to deliver the player, including your IP address. Stream counts previews and paid plays and measures watch time. Filmmakers see totals for their films. We use these records to keep the player running and help filmmakers understand what people watch.</p>
      <p>For paid films, we keep track of which title your order unlocks, when a rental ends and where you left off. If a filmmaker turns on a screener watermark, the player shows a short code tied to the rental. Stream’s super-admins can use it to find the associated payment and checkout email when investigating a reported copy.</p></section>
    <section><h2>When you rent or buy</h2>
      <p>Stripe handles card details, checkout email and billing information. Stream records the order, the film or program, payment status, price, optional tip, fees and tax. We use this information to give you access, pay the filmmaker, answer payment questions and meet tax and accounting obligations.</p>
      <p>To help you recover a film on another device, we match the email you enter to a coded version of your checkout email. If there’s a match, we use Resend to send a private access link. Anyone with your purchase link may be able to use it, so keep it private.</p>
      <p>If you enter a New Mexico viewing address, we send the street, city and ZIP code to the University of New Mexico’s tax district lookup to find the local rate. Other checkouts may use Stripe Tax. <a href="https://grt.edacnm.org/">New Mexico tax district lookup</a></p></section>
    <section><h2>When you release a film</h2>
      <p>We keep your sign-in email, agreement acceptance, film settings and the details you choose to publish. Your title, poster, credits and other published details can appear wherever someone embeds the player. Your original stays in your Cloudflare storage. Stream stores encrypted credentials for the bucket you connect so it can handle uploads and serve your films. We never train AI on your films.</p>
      <p>Stripe collects identity and bank information when you connect an account. Stream receives your Stripe account identifier, setup status and payment and transfer records so we can tell you whether you’re ready to sell and show your earnings.</p></section>
    <section><h2>What stays in your browser</h2>
      <p>Stream uses cookies to keep filmmakers signed in. The player uses browser storage to remember checkout and film access. The site also remembers your choice of light or dark mode. Clearing site data can sign you out or make the player forget a purchase on that device. Your private access link can get you back in.</p></section>
    <section><h2>Who helps run Stream</h2>
      <p>Cloudflare hosts the site, delivers video and checks sign-in and sign-up requests for bots. Stripe processes payments and helps calculate tax. Resend delivers sign-in and recovery emails. These services can process information in the United States and other countries where they operate. We may also share records when the law requires it.</p>
      <p><a href="https://www.cloudflare.com/privacypolicy/">Cloudflare privacy policy</a> · <a href="https://www.cloudflare.com/turnstile-privacy-policy/">Cloudflare security checks</a> · <a href="https://stripe.com/privacy">Stripe privacy policy</a> · <a href="https://resend.com/legal/privacy-policy">Resend privacy policy</a></p></section>
    <section><h2>How long we keep records</h2>
      <p>We keep account information while you use Stream and order records for as long as we need them to honor rentals and purchases, resolve payment issues, and meet our tax and recordkeeping obligations. Sign-in and emailed recovery links expire after 15 minutes. If you close your account, we may still need to keep records of completed sales.</p></section>
    <section><h2>Your choices and how to reach us</h2>
      <p>To ask what we hold about you, correct it, request a copy or deletion, or close your account, email <a href="mailto:info@dustwave.xyz">info@dustwave.xyz</a>. Tell us the email you used and, for a viewing issue, the film title. Please keep card details and private access links out of your message. We may ask you to verify the request.</p>
      <p>Depending on where you live, you may also have the right to object to or restrict certain uses of your information or to complain to your local data protection authority. We use your information to deliver the services you request, meet legal obligations and pursue our legitimate interests in security and audience measurement. If our practices change, we’ll update this page and its date.</p></section>
  </article>`, { reference: true, ...options });
}
