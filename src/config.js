import { createFileSource, createR2Source } from './source.js';

export function sourceFromEnv(env) {
  if (env.STREAM_SOURCE === 'file') return createFileSource(env.STREAM_FILE || '.local/clock.mp4');
  if (env.STREAM_SOURCE && env.STREAM_SOURCE !== 'r2') throw new Error('Choose r2 or file for STREAM_SOURCE.');
  return createR2Source({
    accountId: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET, objectKey: env.R2_OBJECT_KEY,
    accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY
  });
}
