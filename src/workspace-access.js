import { createHash } from 'node:crypto';
import { workspacePage } from './workspace-page.js';
import { agreementFor } from './filmmaker-agreement.js';
import { escapeHtml } from './film-embed.js';
import { mailbox, sendStreamEmail } from './stream-email.js';

export function accessPage({ admin, signup, siteKey, message, error, mode, pilotNotice = '' }) {
  const {path: agreementPath, version: agreementVersion} = agreementFor(mode);
  const title = signup ? 'Create your filmmaker workspace' : admin ? 'Super admin sign-in' : 'Filmmaker sign-in';
  const path = signup ? '/setup/sign-up' : admin ? '/setup/admin/sign-in' : '/setup/sign-in';
  const feedback = message ? `<p class="feedback${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${escapeHtml(message)}</p>` : '';
  const agreement = `<a href="${agreementPath}" target="_blank" rel="noopener">filmmaker agreement</a>`;
  const navigation = admin ? '' : `<nav class="tab-bar subtabs" aria-label="Filmmaker account">
    <a href="/" ${signup ? 'aria-current="page"' : ''}>Sign up</a>
    <a href="/setup/sign-in" ${signup ? '' : 'aria-current="page"'}>Sign in</a></nav>`;
  const action = signup ? 'stream_signup' : admin ? 'stream_admin' : 'stream_filmmaker';
  return workspacePage(title, null, `<section class="sign-in-panel"><h1>${title}</h1>${feedback}
    <div class="field-stack" data-request-link>${navigation}
      ${signup ? `<p>Bring your film to your own site. ${mode === 'live' ? 'Create a free workspace, connect your storage and set a price for rentals or downloads.' : 'Join the free pilot to try rentals and downloads with test payments.'}</p>` : ''}
      ${signup && pilotNotice ? `<p class="hint">${escapeHtml(pilotNotice)}</p>` : ''}
      ${siteKey ? `<form method="post" action="${path}/request">
        <label>Email address<input type="email" name="email" autocomplete="email" inputmode="email" required maxlength="254"></label>
        ${signup ? `<label><input type="checkbox" name="agreement" value="${agreementVersion}" required><span>I agree to the ${agreement}.</span></label>` : ''}
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${action}" data-size="compact"></div>
        <button type="submit">${signup ? 'Email me a sign-up link' : 'Email me a sign-in link'}</button>
        <p class="hint">Your email link works once and expires in 15 minutes.</p></form>` :
        '<p>Email access is temporarily unavailable. Please try again later.</p>'}
    </div>
    <form method="post" action="${path}" data-exchange hidden><input type="hidden" name="code">
      ${signup ? `<input type="hidden" name="agreement" value="${agreementVersion}">
        <p>Confirm your email and accept the ${agreement} to open your workspace.</p>` :
        `<p>Your private link is ready. Continue to open your ${admin ? 'platform analytics' : 'filmmaker workspace'}.</p>`}
      <button type="submit">${signup ? 'Agree and create workspace' : admin ? 'Open platform analytics' : 'Open workspace'}</button></form>
    ${signup ? '' : `<a href="${admin ? '/setup/sign-in' : '/setup/admin/sign-in'}">${admin ? 'Filmmaker sign-in' : 'Super admin sign-in'}</a>`}</section>`,
    { admin, signIn: true, turnstile: Boolean(siteKey) });
}

export const isAccessPath = path => ['/setup/sign-up', '/setup/sign-up/request', '/setup/sign-in', '/setup/sign-in/request',
  '/setup/admin/sign-in', '/setup/admin/sign-in/request'].includes(path);

export async function handleAccess({path, method, get, origin, env, store, mode, siteKey, from,
  showAccess, redirect, reject, cookie, formData, verifyChallenge, mailFetch, queue = () => {}}) {
  const admin = path.startsWith('/setup/admin/');
  const signup = path.startsWith('/setup/sign-up');
  const audience = admin ? 'admin' : 'filmmaker';
  const basePath = admin ? '/setup/admin' : '/setup';
  const agreementVersion = agreementFor(mode).version;
  if (path === basePath + '/sign-in/request' || path === '/setup/sign-up/request') {
    if (method !== 'POST') return reject(405, 'Use the email form.');
    if (!siteKey) return showAccess(503, 'Email access is temporarily unavailable.', true);
    let form;
    try { form = await formData(); } catch { return showAccess(400, 'Use the email form.', true); }
    if (!mailbox(form.email)) return showAccess(400, 'Enter a valid email address.', true);
    if (signup && form.agreement !== agreementVersion) return showAccess(400, 'Read and agree to the filmmaker agreement to sign up.', true);
    const challenge = await verifyChallenge(new Request(origin), env, form['cf-turnstile-response'],
      { secretEnvNames: ['STREAM_TURNSTILE_SECRET_KEY'], action: signup ? 'stream_signup' : 'stream_' + audience });
    if (!challenge.ok) return showAccess(challenge.status, 'The security check could not be verified. Please try again.', true);
    const delivery = signup ? store.requestSignup(form.email, form.agreement) : store.requestLogin(form.email, audience);
    if (delivery) {
      const home = env.STREAM_PUBLIC_ORIGIN || origin;
      const link = home + (delivery.signup ? '/setup/sign-up' : basePath + '/sign-in') + '#magic-link=' + delivery.code;
      const payload = { from, to: [delivery.email], subject: delivery.signup ? 'Confirm your email for Stream' : admin ? 'Sign in to Stream administration' : 'Sign in to Stream',
        text: (delivery.signup ? 'To create your filmmaker workspace, open this link and confirm the filmmaker agreement within 15 minutes.' :
          'Open this private link within 15 minutes to sign in to Stream.') + '\n\n' + link + '\n\nIf you didn’t request this link, you can ignore this email.' };
      queue(sendStreamEmail({ key: env.RESEND_API_KEY, payload, fetchImpl: mailFetch,
        idempotencyKey: 'stream-login-' + createHash('sha256').update(delivery.code).digest('hex') })
        .then(response => { if (!response.ok) throw new Error(); }).catch(() => console.error('Stream sign-in email delivery failed.')));
    }
    return showAccess(200, signup ? 'Check your inbox for a private link to your workspace. If it hasn’t arrived in a few minutes, check your spam folder or try again.' : 'If this email is linked to an account, a sign-in link will arrive shortly. Check your spam folder, too.');
  }
  if (path === basePath + '/sign-in' || path === '/setup/sign-up') {
    if (get) return showAccess(200);
    if (method !== 'POST') return reject(405, 'Use the email form.');
    try {
      const { code, agreement } = await formData();
      const id = signup ? store.confirmSignup(code || '', agreement) : store.signIn(code || '', audience);
      if (!id) return showAccess(401, 'This link is no longer valid. Request a fresh email link.', true);
      return redirect(admin ? basePath : '/setup/settings', { 'Set-Cookie': cookie(id, admin ? 12 * 3600 : 14 * 86400) });
    } catch (e) { return reject(e.statusCode || 400, 'Check the sign-in form and try again.'); }
  }
}
