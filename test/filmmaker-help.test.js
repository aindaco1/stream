import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFilmmakerFaq, renderFilmmakerSettings, renderSetupCosts } from '../src/filmmaker-help.js';

test('setup, settings and public FAQ disclose the same provider rates and link to official terms', () => {
  const stripe = renderSetupCosts('stripe'), r2 = renderSetupCosts('r2');
  for (const view of [stripe,renderFilmmakerSettings(),renderFilmmakerFaq()]) {
    for (const text of ['U.S.', 'domestic card','2.9% + 30¢','custom pricing','https://stripe.com/us/pricing']) assert.ok(view.includes(text),text);
  }
  for (const view of [r2,renderFilmmakerSettings(),renderFilmmakerFaq()]) {
    for (const text of ['10 GB of storage free','$0.015 per GB-month','bandwidth charges',
      'https://developers.cloudflare.com/r2/pricing/']) assert.ok(view.includes(text),text);
  }
  for (const view of [renderFilmmakerFaq(), renderFilmmakerSettings()]) {
    for (const text of ['1 million Class A', '10 million Class B', '$4.50', '$0.36']) assert.ok(view.includes(text), text);
  }
  assert.throws(()=>renderSetupCosts('unknown'),TypeError);
  assert.throws(()=>renderSetupCosts('toString'),TypeError);
});

test('public and signed-in filmmaker information distinguishes sample fees, the sandbox and real storage bills', () => {
  for (const view of [renderFilmmakerFaq(),renderFilmmakerSettings()]) {
    assert.equal(view.match(/<h1>/g)?.length,1);
    for (const text of ['takes no cut','$0.99','$0.33','$0.66','20 GB','$0.15','sandbox','normal usage charges','Sales are final']) {
      assert.ok(view.includes(text),text);
    }
    assert.doesNotMatch(view,/<form\b|<script\b/);
  }
  const settings = renderFilmmakerSettings();
  for (const path of ['/setup#payments','/setup#storage','/setup/dashboard#films']) assert.ok(settings.includes('href="'+path+'"'));
  const faq = renderFilmmakerFaq();
  for (const text of ['invite-only','distribution rights','1 GiB','0 to 30 seconds','starts at purchase','original MP4',
    'iframe','record the screen','private access link','unexpired rentals']) assert.ok(faq.includes(text),text);
});
