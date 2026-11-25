import { createHash } from 'node:crypto';
import { workspacePage, dashboardPath, signInPath, signOutPath } from './workspace-page.js';
import { agreementFor } from './filmmaker-agreement.js';
import { escapeHtml } from './film-embed.js';
import { mailbox, sendStreamEmail, streamLinkEmail } from './stream-email.js';

export { signInPath };
export const signUpPath = '/admin/sign-up';

const routes = new Map([
  [signInPath, signInPath], [signUpPath, signUpPath],
  ['/setup/sign-up', signUpPath], ['/setup/sign-in', signInPath], ['/setup/admin/sign-in', signInPath]
]);

export function accessPath(path) {
  return routes.get(path.replace(/\/request$/, ''));
}

export function sessionCookieName(audience, secure) {
  return (secure ? '__Secure-' : '') + (audience === 'admin' ? 'stream_admin' : 'stream_setup');
}

export function readSessionCookie(cookieHeader, audience, secure) {
  const prefix = sessionCookieName(audience, secure) + '=';
  return cookieHeader?.split(/;\s*/).find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
}

export function headerSession(store, cookieHeader, secure) {
  for (const audience of ['admin', 'filmmaker']) {
    const token = readSessionCookie(cookieHeader, audience, secure);
    const session = token && store.session(token, audience);
    if (session) {
      const admin = audience === 'admin';
      return { action: signOutPath(admin), csrf: session.csrf, dashboard: dashboardPath(admin) };
    }
  }
  return null;
}

export function sessionCookie(value, age, audience, secure) {
  const path = audience === 'admin' ? '/setup/admin' : '/setup';
  return sessionCookieName(audience, secure) + '=' + value + '; Path=' + path +
    '; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
}

export function accessPage({ signup, siteKey, message, error, mode, pilotNotice = '' }) {
  const {path: agreementPath, version: agreementVersion} = agreementFor(mode);
  const title = signup ? 'Sign up' : 'Sign in';
  const path = signup ? signUpPath : signInPath;
  const feedback = message ? `<p class="feedback${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${escapeHtml(message)}</p>` : '';
  const agreement = `<a href="${agreementPath}" target="_blank" rel="noopener">filmmaker agreement</a>`;
  return workspacePage(title, null, `<section class="sign-in-panel">
    <h1>${signup ? 'Sign up for Stream' : 'Sign in to Stream'}</h1>
    ${feedback}
    <div class="field-stack" data-request-link>
      ${pilotNotice || mode === 'test' ? `<p class="hint">${escapeHtml(pilotNotice || 'This rehearsal uses test payments.')}</p>` : ''}
      ${siteKey ? `<form method="post" action="${path}/request">
        <label>Email address<input type="email" name="email" autocomplete="email" inputmode="email" required maxlength="254"></label>
        ${signup ? `<label><input type="checkbox" name="agreement" value="${agreementVersion}" required><span>I agree to the ${agreement}.</span></label>` : ''}
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${signup ? 'stream_signup' : 'stream_signin'}" data-size="compact"></div>
        <button type="submit">${signup ? 'Email me a sign-up link' : 'Email me a sign-in link'}</button>
        <p class="hint">Your email link works once and expires in 15 minutes.</p></form>` :
        '<p>Email access is temporarily unavailable. Please try again later.</p>'}
      ${signup ? '' : `<p>New to Stream? <a href="${signUpPath}">Sign up for free</a></p>`}
    </div>
    <p role="status" data-email-sign-in hidden>${signup ? 'Creating your account…' : 'Signing you in…'}</p>
    <form method="post" action="${path}" data-exchange hidden><input type="hidden" name="code">
      ${signup ? `<input type="hidden" name="agreement" value="${agreementVersion}">` :
        '<p>Your private link is ready. Continue to sign in.</p><button type="submit">Continue to Stream</button>'}</form></section>`,
    { signIn: true, guestSignIn: signup, turnstile: Boolean(siteKey) });
}

export async function handleAccess({path, method, get, origin, env, store, mode, siteKey, from,
  showAccess, redirect, reject, formData, verifyChallenge, mailFetch, queue = () => {}}) {
  const canonical = accessPath(path);
  const signup = canonical === signUpPath;
  const legacyAudience = path.startsWith('/setup/') ? (path.startsWith('/setup/admin/') ? 'admin' : 'filmmaker') : undefined;
  const agreementVersion = agreementFor(mode).version;
  if (get && legacyAudience && !path.endsWith('/request')) return redirect(canonical);
  if (path.endsWith('/request')) {
    if (method !== 'POST') return reject(405, 'Use the email form.');
    if (!siteKey) return showAccess(503, 'Email access is temporarily unavailable.', true);
    let form;
    try { form = await formData(); } catch { return showAccess(400, 'Use the email form.', true); }
    if (!mailbox(form.email)) return showAccess(400, 'Enter a valid email address.', true);
    if (signup && form.agreement !== agreementVersion) return showAccess(400, 'Read and agree to the filmmaker agreement to sign up.', true);
    const challenge = await verifyChallenge(new Request(origin), env, form['cf-turnstile-response'],
      { secretEnvNames: ['STREAM_TURNSTILE_SECRET_KEY'], action: signup ? 'stream_signup' : legacyAudience ? 'stream_' + legacyAudience : 'stream_signin' });
    if (!challenge.ok) return showAccess(challenge.status, 'The security check could not be verified. Please try again.', true);
    const delivery = signup ? store.requestSignup(form.email, form.agreement) : store.requestLogin(form.email, legacyAudience);
    if (delivery) {
      const home = env.STREAM_PUBLIC_ORIGIN || origin;
      const link = home + (delivery.signup ? signUpPath : signInPath) + '#magic-link=' + delivery.code;
      const content = streamLinkEmail(delivery.signup
        ? { subject: 'Confirm your email for Stream', message: 'Confirm your email address to create your filmmaker account.', action: 'Create my account', link }
        : { subject: 'Sign in to Stream', message: 'Open your dashboard with the link below.', action: 'Open my dashboard', link });
      queue(sendStreamEmail({ key: env.RESEND_API_KEY, payload: { from, to: [delivery.email], ...content }, fetchImpl: mailFetch,
        idempotencyKey: 'stream-login-' + createHash('sha256').update(delivery.code).digest('hex') })
        .then(response => { if (!response.ok) throw new Error(); }).catch(() => console.error('Stream sign-in email delivery failed.')));
    }
    return showAccess(200, signup ? 'Check your inbox for a private link to Stream. If it hasn’t arrived in a few minutes, check your spam folder or try again.' : 'If this email is linked to an account, a sign-in link will arrive shortly. Check your spam folder, too.');
  }

  if (get) return showAccess(200);
  if (method !== 'POST') return reject(405, 'Use the email form.');
  try {
    const { code, agreement } = await formData();
    const login = signup
      ? { id: store.confirmSignup(code || '', agreement), audience: 'filmmaker' }
      : store.redeemLogin(code || '', legacyAudience);
    if (!login?.id) return showAccess(401, 'This link is no longer valid. Request a fresh email link.', true);
    const admin = login.audience === 'admin';
    const destination = signup ? '/setup/settings' : dashboardPath(admin);
    return redirect(destination, { 'Set-Cookie': sessionCookie(login.id, admin ? 12 * 3600 : 14 * 86400, login.audience, origin.startsWith('https:')) });
  } catch (e) { return reject(e.statusCode || 400, 'Check the sign-in form and try again.'); }
}
