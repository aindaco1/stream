import { createFileSource, createR2Source } from './source.js';

// Public IDs are permanent. Retain the first maker's issued receipt scopes when
// introducing another tenant, even if both files have the same source revision.
const films = new Map([
  ['clock', { title: 'Projection test', maker: 'maker-a', scope: 'clock' }],
  ['second', { title: 'Second screening', maker: 'maker-a', scope: 'second' }],
  ['feature', { title: 'Feature screening', maker: 'maker-b', scope: 'maker-b/feature' }]
]);
for (const spec of films.values()) Object.freeze(spec);

export function filmSpec(id) {
  return films.get(id);
}

export function sourceFromEnv(env, maker = 'maker-a') {
  if (env.STREAM_SOURCE === 'file') {
    const file = env.STREAM_FILE || (maker === 'maker-a' && '.local/clock.mp4');
    if (!file) throw new Error('Set a file path for this filmmaker.');
    return createFileSource(file);
  }
  if (env.STREAM_SOURCE && env.STREAM_SOURCE !== 'r2') throw new Error('Choose r2 or file for STREAM_SOURCE.');
  return createR2Source({
    accountId: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET, objectKey: env.R2_OBJECT_KEY,
    accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY
  });
}
