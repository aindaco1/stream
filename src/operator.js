import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function operatorDirectory(env = process.env) {
  const base = process.platform === 'darwin' ? 'Library/Application Support/Dust Wave Stream Prototype' :
    '.local/state/dust-wave-stream-prototype';
  return env.STREAM_STATE_DIR || join(homedir(), base);
}

export async function playbackSettings({ signing = false } = {}, env = process.env) {
  const directory = operatorDirectory(env);
  const fields = {
    'source.env': ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_OBJECT_KEY'],
    'r2.env': ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  };
  if (signing) fields['rental.env'] = ['STREAM_RENTAL_SECRET'];
  const result = { ...env };
  for (const [name, keys] of Object.entries(fields)) {
    let values;
    try {
      values = parseEnv(await readFile(join(directory, name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const key of keys) result[key] ??= values[key];
  }
  return result;
}
