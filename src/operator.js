import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function operatorDirectory(env = process.env) {
  const base = process.platform === 'darwin' ? 'Library/Application Support/Dust Wave Stream Prototype' :
    '.local/state/dust-wave-stream-prototype';
  return env.STREAM_STATE_DIR || join(homedir(), base);
}

export async function playbackSettings({ signing = false, maker = 'maker-a' } = {}, env = process.env) {
  if (maker !== 'maker-a' && maker !== 'maker-b') throw new Error('Unknown filmmaker.');
  const primary = maker === 'maker-a';
  const directory = primary ? operatorDirectory(env) : join(operatorDirectory(env), 'feature');
  const fields = {
    'source.env': ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_OBJECT_KEY', 'STREAM_SOURCE', 'STREAM_FILE'],
    'r2.env': ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  };
  if (signing) fields['rental.env'] = ['STREAM_RENTAL_SECRET'];
  // The original single-film CLI accepts environment overrides. The second
  // filmmaker always uses its own directory, including its independent key.
  const result = {};
  for (const [name, keys] of Object.entries(fields)) {
    let values = {};
    try {
      values = parseEnv(await readFile(join(directory, name), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const key of keys) result[key] = primary ? env[key] ?? values[key] : values[key];
  }
  return result;
}
