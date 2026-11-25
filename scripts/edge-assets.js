import { copyFile, mkdir, rename, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceAssets } from '../src/workspace-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, '.local');
await mkdir(dir, { recursive: true });
const temp = await mkdtemp(join(dir, 'edge-assets-'));
for (const [route, source] of Object.entries(workspaceAssets)) {
  const file = source.startsWith('@') ? fileURLToPath(import.meta.resolve(source)) : join(root, 'src', source);
  const output = join(temp, route.slice(1));
  await mkdir(dirname(output), { recursive: true });
  await copyFile(file, output);
}
const destination = join(dir, 'worker-assets');
await rm(destination, { recursive: true, force: true });
await rename(temp, destination);
