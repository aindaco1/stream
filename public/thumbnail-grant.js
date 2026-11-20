// Cloudflare R2 local signing. Only the resulting JWT goes to Stream.
export async function thumbnailGrant({ account, host, bucket, key }, id, secret) {
  if (!/^[a-f\d]{32}$/i.test(id) || !/^[a-f\d]{64}$/i.test(secret)) throw new Error('Enter the Access Key ID and Secret Access Key from Cloudflare.');
  const encode = value => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: account, iss: id, aud: host, bucket, iat: now, exp: now + 3600,
    actions: ['PutObject', 'DeleteObject'], paths: { objectPaths: [key] } };
  const unsigned = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + encode(JSON.stringify(payload));
  const utf8 = new TextEncoder();
  const signer = await crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', signer, utf8.encode(unsigned));
  return { expires: payload.exp, jwt: unsigned + '.' + encode(String.fromCharCode(...new Uint8Array(signature))) };
}
