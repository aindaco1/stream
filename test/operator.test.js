import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playbackSettings } from '../src/operator.js';
import { filmSpec, sourceFromEnv } from '../src/config.js';

test('feature source and signing configuration can only come from that maker’s directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stream-operator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    STREAM_STATE_DIR: root, STREAM_SOURCE: 'file', STREAM_FILE: 'a.mp4', R2_ACCOUNT_ID: 'a',
    R2_BUCKET: 'a-bucket', R2_OBJECT_KEY: 'a.mp4', R2_ACCESS_KEY_ID: 'a-id',
    R2_SECRET_ACCESS_KEY: 'a-secret', STREAM_RENTAL_SECRET: 'a-sign'
  };
  await writeFile(join(root, 'source.env'), 'R2_BUCKET=file-bucket\n');
  await mkdir(join(root, 'feature'));
  assert.equal((await playbackSettings({ signing: true }, env)).R2_BUCKET, 'a-bucket');
  const options = { signing: true, maker: filmSpec('feature').maker };
  const empty = await playbackSettings(options, env);
  assert.ok(Object.values(empty).every(v => v === undefined));
  assert.throws(() => sourceFromEnv(empty, options.maker));
  assert.throws(() => sourceFromEnv({ STREAM_SOURCE: 'file' }, options.maker));
  await writeFile(join(root, 'feature/source.env'), 'R2_ACCOUNT_ID=b\nR2_OBJECT_KEY=b.mp4\nR2_BUCKET=b-bucket\n');
  await writeFile(join(root, 'feature/r2.env'), 'R2_ACCESS_KEY_ID=b-id\nR2_SECRET_ACCESS_KEY=b-secret\nSTREAM_RENTAL_SECRET=wrong-source\n');
  await writeFile(join(root, 'feature/rental.env'), 'STREAM_RENTAL_SECRET=b-sign\n');
  const settings = await playbackSettings(options, env);
  assert.deepEqual(settings, {
    STREAM_SOURCE: undefined, STREAM_FILE: undefined, R2_ACCOUNT_ID: 'b', R2_BUCKET: 'b-bucket',
    R2_OBJECT_KEY: 'b.mp4', R2_ACCESS_KEY_ID: 'b-id', R2_SECRET_ACCESS_KEY: 'b-secret',
    STREAM_RENTAL_SECRET: 'b-sign'
  });
  assert.equal((await playbackSettings({ maker: options.maker }, env)).STREAM_RENTAL_SECRET, undefined);
  await assert.rejects(playbackSettings({ maker: 'typo' }, env));
});
