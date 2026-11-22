import { faqLink, siteFooter, siteIcons } from './site-frame.js';
import { escapeHtml } from './film-embed.js';
import { hidden } from './offer-fields.js';

const publicDescriptions = new Map([
  ['Create your filmmaker workspace', 'Embed your films on your own website. Join the Stream pilot to try previews, rentals and downloads with your own film storage.'],
  ['Filmmaker sign-in', 'Sign in to your Stream filmmaker workspace with a private email link.'],
  ['FAQ', 'Learn how to put a film on your website, create a program, connect storage and payments, and understand fees and viewer access.'],
  ['Filmmaker agreement', 'Read the Stream pilot terms for filmmakers, including film ownership, permissions, storage and viewer access.']
]);

export function workspacePage(title, csrf, content, { dashboard = false, builder = false, filmUpload = false, programEditor = false, programPreview = false, admin = false, faq = false, reference = false, signIn = false, signInHref = '/setup/sign-in', turnstile = false } = {}) {
  const current = ' aria-current="page"';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    ${siteIcons}
    ${publicDescriptions.has(title) ? `<meta name="description" content="${escapeHtml(publicDescriptions.get(title))}">` : ''}
    <title>${escapeHtml(title)} · Stream</title><link rel="stylesheet" href="/site-frame.css"><link rel="stylesheet" href="/filmmaker.css">
    <link rel="stylesheet" href="/filmmaker-dark.css" media="(prefers-color-scheme: dark)" data-appearance-dark>
    ${programPreview ? '<link rel="stylesheet" href="/program-lineup.css">' : ''}
    <script src="/appearance.js" data-appearance-key="stream.filmmaker.appearance"></script>
    <script type="module" src="/select-focus.js"></script>
    ${csrf ? '<script type="module" src="/setup/field-help.js"></script>' : ''}
    ${turnstile ? '<script src="/setup/turnstile-size.js" defer></script>' : ''}
    ${signIn ? '<script src="/setup/sign-in.js" defer></script>' : csrf && !admin ? '<script type="module" src="/setup/navigation.js"></script>' : ''}
    ${(builder || admin) && csrf ? '<script type="module" src="/setup/analytics-refresh.js"></script>' : ''}
    ${builder ? '<script type="module" src="/setup/dashboard.js"></script><script type="module" src="/setup/thumbnail.js"></script>' : ''}
    ${programEditor ? '<script type="module" src="/setup/program-editor.js"></script><script type="module" src="/setup/thumbnail.js"></script>' : ''}
    ${filmUpload ? '<script type="module" src="/setup/video-upload.js"></script>' : ''}</head>
    <body><a class="skip" href="#main">Skip to content</a>
    <header class="masthead"><div class="bar"><a class="brand" href="${admin ? '/setup/admin' : '/'}" aria-label="Stream home">Stream</a>
      ${faqLink(faq, admin ? '/setup/admin/faq' : csrf ? '/setup/faq' : '/faq')}
      <label class="appearance" title="Appearance"><span aria-hidden="true">🌓</span><select aria-label="Appearance" data-appearance-select>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      ${csrf ? `<form method="post" action="${admin ? '/setup/admin/sign-out' : '/setup/sign-out'}">${hidden('csrf', csrf)}
        <button class="sign-out" type="submit">Sign out</button></form>` : signIn ? '' : `<a href="${escapeHtml(signInHref)}">Sign in</a>`}</div>
      ${csrf && !admin ? `<nav class="workspace-nav" aria-label="Workspace navigation"><div class="tab-bar">
        <a href="/setup/dashboard"${dashboard && !faq ? current : ''}>Dashboard</a>
        <a href="/setup/settings"${dashboard || faq || reference ? '' : current}>Settings</a>
      </div></nav>` : ''}</header>
    <main class="setup-shell${faq ? ' filmmaker-help' : ''}" id="main" tabindex="-1">${content}</main>
    ${siteFooter(admin ? '/setup/admin' : '/')}</body></html>`;
}
