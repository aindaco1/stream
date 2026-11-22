import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function createMaintenanceServer(secret, reconcile) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('Configure STREAM_MAINTENANCE_SECRET for scheduled reconciliation.');
  const expected = Buffer.from('Bearer ' + secret);
  let running;
  return createServer({headersTimeout:10000,requestTimeout:15000}, async (req,res) => {
    const auth = Buffer.from(req.headers.authorization || '');
    res.setHeader('Cache-Control','no-store');
    if (req.url !== '/reconcile' || req.method !== 'POST' ||
        req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0 ||
        auth.length !== expected.length || !timingSafeEqual(auth,expected)) return res.writeHead(404).end();
    try {
      running ??= Promise.resolve().then(reconcile).finally(() => { running = undefined; });
      res.writeHead(await running ? 204 : 503).end();
    } catch { res.writeHead(503).end(); }
  });
}
