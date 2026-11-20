import { createHash, createHmac, randomUUID } from 'node:crypto';
import { r2Request } from './source.js';

function delegate(settings, permissions) {
  const { accountId, bucket, jurisdiction = 'default', accessKeyId, secretAccessKey } = settings;
  const region = jurisdiction === 'default' ? '' : '.' + jurisdiction;
  const issued = Math.floor(Date.now() / 1000);
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const unsigned = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({
    sub: accountId, iss: accessKeyId, aud: accountId + region + '.r2.cloudflarestorage.com',
    iat: issued, exp: issued + 3600, bucket, ...permissions
  });
  const jwt = unsigned + '.' + createHmac('sha256', secretAccessKey).update(unsigned).digest('base64url');
  return { accountId, bucket, jurisdiction, accessKeyId,
    secretAccessKey: createHash('sha256').update(jwt).digest('hex'), sessionToken: Buffer.from('jwt/' + jwt).toString('base64') };
}
export const bucketReader = settings => delegate(settings, { scope: 'object-read-only' });
export const objectWriter = (settings, objectKey, actions) => delegate(settings, { actions, paths: { objectPaths: [objectKey] } });

export async function verifyUploadAccess(settings, fetcher = fetch) {
  // A unique object and a conditional PUT keep every existing file untouched.
  const key = 'stream-thumbnails/f-' + randomUUID() + '.jpg';
  const request = r2Request(objectWriter(settings, key, ['PutObject', 'DeleteObject']), '/' + key, fetcher);
  const created = await request('PUT', { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, undefined, Buffer.from('Stream bucket setup'));
  await created.body?.cancel();
  if (!created.ok) throw new Error('R2 rejected the upload check.');
  const removed = await request('DELETE');
  await removed.body?.cancel();
  if (!removed.ok) throw new Error('R2 rejected removal of the setup check.');
}
