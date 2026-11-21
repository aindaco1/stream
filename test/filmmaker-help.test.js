import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFilmmakerFaq, renderSetupCosts } from '../src/filmmaker-help.js';
import { renderStripeCountryForm } from '../src/setup-view.js';
import { payoutCountryOptions } from '../src/payout-countries.js';

test('Payments and FAQ match the country selector and explain filmmaker ownership and sandbox proceeds', () => {
  const form = renderStripeCountryForm('csrf','new');
  const selection = [...form.matchAll(/<option value="([A-Z]{2})"/g)].map(match => match[1]).sort();
  assert.equal(selection.join(' '), 'AT BE BG CA CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IT LI LT LU LV MT NL NO PL PT RO SE SI SK US');
  for (const page of [renderSetupCosts('stripe'), renderFilmmakerFaq()]) {
    for (const {label} of payoutCountryOptions) assert.ok(page.includes(label), label);
    for (const text of ['You keep your film rights', 'your sales', 'U.S. dollars', 'currency conversion', 'test cards']) assert.ok(page.includes(text),text);
  }
});

test('provider settings and public FAQ disclose the same provider rates and link to official terms', () => {
  const stripe = renderSetupCosts('stripe'), r2 = renderSetupCosts('r2');
  for (const view of [stripe,renderFilmmakerFaq()]) {
    for (const text of ['U.S.', 'domestic card','2.9% + 30¢','0.5% of the full checkout total','custom pricing',
      'You cover the share for the film', 'Dust Wave covers the share for the tip', 'once the actual fees are confirmed', 'https://stripe.com/us/pricing']) assert.ok(view.includes(text),text);
  }
  for (const view of [r2,renderFilmmakerFaq()]) {
    for (const text of ['10 GB of storage free','$0.015 per GB-month','bandwidth charge',
      'https://developers.cloudflare.com/r2/pricing/']) assert.ok(view.includes(text),text);
  }
  const faq = renderFilmmakerFaq();
  for (const text of ['1 million Class A', '10 million Class B', '$4.50', '$0.36']) assert.ok(faq.includes(text), text);
  assert.throws(()=>renderSetupCosts('unknown'),TypeError);
  assert.throws(()=>renderSetupCosts('toString'),TypeError);
});

test('the public FAQ explains costs, the pilot and how to sell films', () => {
  const faq = renderFilmmakerFaq();
  assert.equal(faq.match(/<h1>/g)?.length, 1);
  for (const text of ['<h1>FAQ</h1>', '$0.99','$0.33','$0.66','20 GB','$0.15','test cards','real storage','Sales are final','optional tip','10% of the film price','0% to skip it']) {
    assert.ok(faq.includes(text), text);
  }
  assert.doesNotMatch(faq, /<form\b|<script\b/);
  for (const text of ['invite-only','permission to distribute','10 GB','30 seconds','starts when they pay','original file',
    'embed code','record their screen','private access link','text subtitles','picture subtitles']) assert.ok(faq.includes(text),text);
});

test('the FAQ explains marketplace tax and separates sandbox testing from live obligations', () => {
  const faq = renderFilmmakerFaq();
  assert.match(faq, /film tax is added to your price/);
  assert.match(faq, /tax on an optional tip is included in the tip amount/);
  assert.match(faq, /99¢ rental with a 10¢ tip came to \$1\.17/);
  assert.match(faq, /Stripe asks the viewer to confirm or correct it/);
  assert.match(faq, /the viewer’s billing address/);
  assert.match(faq, /finish verification/);
  assert.match(faq, /picture-in-picture button on the video/);
  assert.match(faq, /test charge can show zero tax/);
  assert.match(faq, /registering and filing wherever it handles marketplace tax/);
  assert.match(faq, /https:\/\/docs\.stripe\.com\/tax\/testing/);
});
