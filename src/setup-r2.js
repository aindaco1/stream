import { createHash } from 'node:crypto';
import { readBoundedJson } from '@dustwave/worker-core/response-body';

const ID = /^[a-f0-9]{32}$/i;
const BUCKET_PATH = /^\/([a-fA-F0-9]{32})\/r2\/(?:(default|eu|us|fedramp)\/)?buckets\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])(?:\/(?:objects|settings|metrics))?\/?$/;
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN_HELP = 'Check the R2 token value or use the Access Key ID and Secret Access Key from its creation screen.';
const UNAVAILABLE = 'Cloudflare token verification is unavailable. Try again or enter your R2 access key pair.';

export class R2SetupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function parseR2BucketUrl(value) {
  const invalid = () => new R2SetupError('Open the bucket in the Cloudflare dashboard and copy its address from your browser.');
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  const address = value.trim();
  // Reject path normalization before URL can fold a different dashboard path into a bucket path.
  if (!/^https:\/\//i.test(address) || /[\\\x00-\x20\x7f]/.test(address) ||
      /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(address.split(/[?#]/, 1)[0])) throw invalid();
  let url;
  try { url = new URL(address); } catch { throw invalid(); }
  const path = BUCKET_PATH.exec(url.pathname);
  if (url.origin !== 'https://dash.cloudflare.com' || url.username || url.password || !path) throw invalid();
  return { accountId: path[1].toLowerCase(), jurisdiction: path[2] ?? 'default', bucket: path[3] };
}

function verificationUrls(token, accountId) {
  const account = `${API}/accounts/${accountId}/tokens/verify`;
  const user = `${API}/user/tokens/verify`;
  // Cloudflare validates the opaque payload and checksum. Enforce our form/header bounds locally.
  if (token.length <= 5 || token.length > 256 || !/^[!-~]+$/.test(token)) throw new R2SetupError(TOKEN_HELP);
  if (token.startsWith('cfat_')) return [account];
  if (token.startsWith('cfut_')) return [user];
  // The legacy format has no ownership marker. Lowercase hex overlaps with historical Global API Keys.
  if (/^[A-Za-z0-9_-]{40}$/.test(token) && !/^[a-f0-9]{40}$/.test(token) && !/^cf[a-z]+_/.test(token)) return [account, user];
  throw new R2SetupError(TOKEN_HELP);
}

async function verifiedId(token, accountId, fetchImpl) {
  const urls = verificationUrls(token, accountId);
  const signal = AbortSignal.timeout(8000);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if ([400, 401, 403, 404].includes(response.status)) continue;
        throw new R2SetupError(UNAVAILABLE, 503);
      }
      const body = await readBoundedJson(response, 16 * 1024);
      const record = body?.result;
      const now = Date.now();
      if (body?.success !== true || record?.status !== 'active' || typeof record.id !== 'string' || !ID.test(record.id) ||
          (record.not_before != null && !(typeof record.not_before === 'string' && Date.parse(record.not_before) <= now)) ||
          (record.expires_on != null && !(typeof record.expires_on === 'string' && Date.parse(record.expires_on) > now))) {
        throw new R2SetupError(TOKEN_HELP);
      }
      return record.id.toLowerCase();
    } catch (error) {
      if (error instanceof R2SetupError) throw error;
      // Provider bodies and transport errors can contain submitted credentials.
      throw new R2SetupError(UNAVAILABLE, 503);
    }
  }
  throw new R2SetupError(TOKEN_HELP);
}

export async function guidedBucketForm(data, { fetchImpl = fetch } = {}) {
  if (data?.privateConfirmed !== 'yes') throw new R2SetupError('Confirm that the bucket is private and the token is limited to that bucket.');
  const location = parseR2BucketUrl(data.bucketUrl);
  const fields = [data.tokenValue ?? '', data.accessKeyId ?? '', data.secretAccessKey ?? ''];
  if (!fields.every(value => typeof value === 'string')) throw new R2SetupError(TOKEN_HELP);
  const [token, accessKeyId, secretAccessKey] = fields.map(value => value.trim());
  if (accessKeyId || secretAccessKey) {
    if (token || !ID.test(accessKeyId) || !/^[a-f0-9]{64}$/i.test(secretAccessKey)) {
      throw new R2SetupError('Enter both R2 access key values together, or use the separate token value form.');
    }
    return { ...location, accessKeyId, secretAccessKey };
  }
  const id = await verifiedId(token, location.accountId, fetchImpl);
  // Cloudflare's R2 authentication contract derives the S3 pair from the token ID and exact token bytes.
  return { ...location, accessKeyId: id, secretAccessKey: createHash('sha256').update(token).digest('hex') };
}
