import { prepareResendEmail } from '@dustwave/worker-core/email';
import { escapeHtml } from './film-embed.js';

export function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254) return;
  const email = value.trim();
  const match = /^([^\s@<>,;:"\\]+)@([a-z\d.-]+\.[a-z]{2,})$/i.exec(email);
  if (match && !/[\x00-\x1f\x7f]/.test(value)) return match[1] + '@' + match[2].toLowerCase();
}

export function streamSender(env) {
  if (!env.STREAM_RECOVERY_FROM || !env.RESEND_API_KEY) return;
  const sender = env.STREAM_RECOVERY_FROM.trim();
  const address = mailbox(sender.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/u)?.[1] ?? sender);
  if (!address) throw new Error('STREAM_RECOVERY_FROM must contain one verified sender address.');
  return `Stream <${address}>`;
}

// One direct, single-use link in either format. Keep the wordmark readable with images blocked.
export function streamLinkEmail({ subject, message, action, link }) {
  const expiry = 'This private link works once and expires in 15 minutes.';
  const footer = 'If you didn’t request this link, you can ignore this email.';
  const text = [subject, message, expiry, action + '\n' + link, footer].join('\n\n');
  const title = escapeHtml(subject);
  const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
@media (prefers-color-scheme: dark) {
  .page { background-color: #151515 !important; }
  .letter { background-color: #202020 !important; color: #fafafa !important; }
  .rule, .note { border-color: #636363 !important; }
  .note { color: #cecece !important; }
  .action { color: #151515 !important; background-color: #fafafa !important; border-color: #fafafa !important; }
}
</style>
</head>
<body class="page" style="margin:0;background-color:#f5f4f1">
<div class="page" lang="en" dir="ltr" style="padding:24px 12px;background-color:#f5f4f1">
<!--[if mso]><table role="presentation" align="center" width="560"><tr><td><![endif]-->
<div class="letter" style="max-width:512px;margin:0 auto;padding:24px;background-color:#ffffff;color:#171717;font-family:Arial,Helvetica,sans-serif">
  <p class="rule" style="margin:0 0 24px;padding-bottom:16px;border-bottom:2px dashed #777777;font-size:30px;line-height:34px;font-weight:bold;letter-spacing:-1.5px">Stream</p>
  <h1 style="margin:0 0 12px;font:normal 32px/1.12 Georgia,'Times New Roman',serif;letter-spacing:-0.8px">${title}</h1>
  <p style="margin:0 0 8px;font-size:16px;line-height:24px;overflow-wrap:anywhere">${escapeHtml(message)}</p>
  <p style="margin:0 0 20px;font-size:16px;line-height:24px">${expiry}</p>
  <a class="action" href="${escapeHtml(link)}" style="display:inline-block;background-color:#171717;color:#ffffff;border:solid #171717;border-width:12px 18px;border-radius:4px;font-size:16px;line-height:22px;font-weight:bold;text-decoration:none">${escapeHtml(action)}</a>
  <p class="note" style="margin:24px 0 0;padding-top:16px;border-top:1px solid #cccccc;color:#545454;font-size:14px;line-height:21px">${footer}</p>
</div>
<!--[if mso]></td></tr></table><![endif]-->
</div>
</body>
</html>`;
  return { subject, text, html };
}

export function sendStreamEmail({ key, payload, idempotencyKey, fetchImpl = fetch }) {
  return fetchImpl('https://api.resend.com/emails', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(prepareResendEmail(payload))
  });
}
