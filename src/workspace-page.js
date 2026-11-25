import { faqLink, siteBrand, siteFooter, siteIcons } from './site-frame.js';
import { escapeHtml } from './film-embed.js';
import { hidden } from './offer-fields.js';

const publicDescriptions = new Map([
  ['Rent and sell independent films on your own site', 'Give your audience a place to watch. Embed rentals and downloads on your own site with no Stream subscription or commission.'],
  ['Sign up', 'Reach viewers on the open web. Set your prices, keep your rights and sell rentals or downloads directly from your film player.'],
  ['Sign in', 'Sign in to Stream with a private email link.'],
  ['Screening room', 'Preview films and programs and rent or buy directly in the player.'],
  ['FAQ', 'Learn how to put a film on your website, create a program, connect storage and payments, and understand fees and viewer access.'],
  ['Filmmaker agreement', 'Read the Stream pilot terms for filmmakers, including film ownership, permissions, storage and viewer access.']
]);

// Both existing session cookies reach this path, including on visits from public pages.
export const headerSessionPath = '/setup/admin/header-session';
export const signOutPath = admin => admin ? '/setup/admin/sign-out' : '/setup/sign-out';

function signOutForm(csrf, admin) {
  return `<form method="post" action="${signOutPath(admin)}">${hidden('csrf', csrf)}
    <button class="sign-out" type="submit">Sign out</button></form>`;
}

export function workspacePage(title, csrf, content, { dashboard = false, builder = false, filmUpload = false, programEditor = false, programPreview = false, admin = false, faq = false, reference = false, signIn = false, guestSignIn, landing = false, viewer = false, screening = false, home = admin ? '/setup/admin' : '/', turnstile = false } = {}) {
  const current = ' aria-current="page"';
  const checkSession = !csrf && !viewer;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    ${siteIcons}
    ${publicDescriptions.has(title) ? `<meta name="description" content="${escapeHtml(publicDescriptions.get(title))}">` : ''}
    <title>${escapeHtml(title)} · Stream</title><link rel="stylesheet" href="/site-frame.css"><link rel="stylesheet" href="/filmmaker.css">
    <link rel="stylesheet" href="/filmmaker-dark.css" media="(prefers-color-scheme: dark)" data-appearance-dark>
    ${landing ? '<link rel="stylesheet" href="/filmmaker-home.css"><script type="module" src="/play-excerpt.js"></script>' : ''}
    ${screening ? '<link rel="stylesheet" href="/screening.css">' : ''}
    ${checkSession ? '<script type="module" src="/setup/header-session.js"></script>' : ''}
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
    <header class="masthead"><div class="bar">${siteBrand(home)}
      ${faqLink(faq, admin ? '/setup/admin/faq' : csrf ? '/setup/faq' : '/faq')}
      ${guestSignIn && !csrf ? `<a href="${guestSignIn}" data-guest-sign-in>Sign in</a>` : ''}
      ${csrf ? signOutForm(csrf, admin) : checkSession ? `<template data-header-session="${headerSessionPath}"${landing ? ' data-home' : ''}>${signOutForm('', false)}</template>` : ''}</div></header>
      ${csrf && !admin ? `<nav class="workspace-nav" aria-label="Workspace navigation"><div class="tab-bar">
        <a href="/setup/dashboard"${dashboard && !faq ? current : ''}>Dashboard</a>
        <a href="/setup/settings"${dashboard || faq || reference ? '' : current}>Settings</a>
      </div></nav>` : ''}
    <main class="setup-shell${landing ? ' filmmaker-home' : faq ? ' filmmaker-help' : screening ? ' screening-room' : ''}" id="main" tabindex="-1">${content}</main>
    ${siteFooter(home)}</body></html>`;
}
