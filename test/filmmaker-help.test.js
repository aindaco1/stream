import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFilmmakerFaq } from '../src/filmmaker-help.js';
import { renderSettingsPage, renderStripeCountryForm } from '../src/setup-view.js';
import { payoutCountryOptions } from '../src/payout-countries.js';

test('FAQ matches the actual filmmaker country selector and explains the sandbox', () => {
  const form = renderStripeCountryForm('csrf', 'new');
  const selection = [...form.matchAll(/<option value="([A-Z]{2})"/g)].map(match => match[1]).sort();
  assert.equal(selection.join(' '), 'AT BE BG CA CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IT LI LT LU LV MT NL NO PL PT RO SE SI SK US');
  const faq = renderFilmmakerFaq();
  for (const { label } of payoutCountryOptions) assert.ok(faq.includes(label), label);
  for (const text of ['You keep your film rights', 'weekly bank deposits', 'U.S. dollars', 'currency conversion', 'test cards']) assert.ok(faq.includes(text), text);
});

test('settings link into a single public FAQ for provider setup, rates and payout details', () => {
  const faq = renderFilmmakerFaq(), settings = renderSettingsPage({ csrf: 'test' });
  for (const topic of ['storage', 'payments']) {
    assert.ok(settings.includes(`href="/setup/faq#${topic}"`));
    assert.ok(faq.includes(`<section id="${topic}">`));
  }
  for (const [, anchor] of faq.matchAll(/href="#([^"]+)"/g)) {
    assert.equal(faq.split(`id="${anchor}"`).length, 2, anchor);
  }
  for (const text of ['2.9% + 30¢', '0.5% per transaction', '10 GB-month', '$0.015 per GB-month', '1 million Class A',
    '10 million Class B', '$4.50', '$0.36', 'weekly bank deposits', 'Cross-border fees']) {
    assert.ok(faq.includes(text), text);
    assert.ok(!settings.includes(text), text);
  }
  assert.doesNotMatch(settings, /About Stripe setup|provider-costs/);
  for (const text of ['Object Read &amp; Write', 'Replace R2 key', 'New sales pause', 'Publish changes', 'Infrequent Access',
    'https://stripe.com/tax/pricing', 'https://developers.cloudflare.com/r2/pricing/']) assert.ok(faq.includes(text), text);
});

test('the public FAQ explains costs, the pilot and how to sell films', () => {
  const faq = renderFilmmakerFaq();
  assert.equal(faq.match(/<h1>/g)?.length, 1);
  for (const text of ['<h1>FAQ</h1>', '$0.99','$0.33','$0.66','20 GB','$0.15','test cards','real storage','Sales are final','optional tip','10% of the film price','0% to skip it']) {
    assert.ok(faq.includes(text), text);
  }
  assert.doesNotMatch(faq, /<form\b|<script\b|Stream on GitHub/);
  assert.equal(faq.match(/<h2>(.*?)<\/h2>/)?.[1], 'How do I put a film on my site?');
  for (const step of ['Copy embed code','Custom HTML','publish your page']) assert.ok(faq.includes(step));
  for (const text of ['invite-only','permission to distribute','10 GB','180 seconds','starts when they pay','original file',
    'embed code','record their screen','private access link','text subtitles','picture subtitles']) assert.ok(faq.includes(text),text);
});

test('the FAQ explains marketplace tax and separates sandbox testing from live obligations', () => {
  const faq = renderFilmmakerFaq();
  assert.match(faq, /film tax is added to your price/);
  assert.match(faq, /tax on an optional tip is included in the tip amount/);
  assert.match(faq, /99¢ rental with a 10¢ tip came to \$1\.17/);
  assert.match(faq, /uses Stripe Tax with a viewing address/);
  assert.match(faq, /the viewer’s billing address/);
  assert.match(faq, /finish verification/);
  assert.match(faq, /picture-in-picture button on the video/);
  assert.match(faq, /test charge can show zero tax/);
  assert.match(faq, /marketplace registrations, filing and remittance/);
  assert.match(faq, /https:\/\/docs\.stripe\.com\/tax\/testing/);
});
