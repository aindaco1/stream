import { prepareResendEmail } from '@dustwave/worker-core/email';

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

export function sendStreamEmail({ key, payload, idempotencyKey, fetchImpl = fetch }) {
  return fetchImpl('https://api.resend.com/emails', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(prepareResendEmail(payload))
  });
}
