import assert from 'node:assert/strict';
import { isIPv4 } from 'node:net';

// Receipts are test credentials. Mobile runs opt into one local network interface.
export function rehearsalOrigins() {
  const bind = process.env.STREAM_PUBLISHER_BIND || '127.0.0.1';
  const publisherHost = (process.env.STREAM_PUBLISHER_HOST || 'localhost').toLowerCase();
  const player = new URL(process.env.STREAM_BASE_URL || 'http://127.0.0.1:8895');
  const local = isIPv4(bind) && /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(bind);
  assert.ok(local, 'Choose a local loopback or private LAN IPv4 interface');
  assert.ok(
    /^(?:localhost|[a-z0-9-]+\.local)$/.test(publisherHost),
    'Use localhost or the Mac’s Bonjour name',
  );
  assert.ok(
    player.protocol === 'http:' &&
      !player.username &&
      !player.password &&
      player.pathname === '/' &&
      !player.search &&
      !player.hash,
    'Supply a local HTTP origin without credentials',
  );
  assert.ok(
    ['localhost', '127.0.0.1'].includes(player.hostname),
    'Only a loopback Stream app receives purchases',
  );
  assert.notEqual(
    publisherHost,
    player.hostname,
    'Use different hostnames for the embedding site and player',
  );
  return { bind, publisherHost, player };
}
