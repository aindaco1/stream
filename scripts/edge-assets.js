import { copyFile, mkdir, rename, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, '.local');
await mkdir(dir, { recursive: true });
const temp = await mkdtemp(join(dir, 'edge-assets-'));
const files = {
  'favicon.svg': 'favicon.svg',
  'favicon.ico': 'favicon.ico',
  'apple-touch-icon.png': 'apple-touch-icon.png',
  'dust-wave-square.webp': 'dust-wave-square.webp',
  'site-frame.css': 'site-frame.css',
  'filmmaker.css': 'setup.css',
  'filmmaker-dark.css': 'setup-dark.css',
  'select-focus.js': 'select-focus.js',
  'setup/header-session.js': 'header-session.js',
  'setup/sign-in.js': 'sign-in.js',
  'setup/field-help.js': 'field-help.js',
  'setup/analytics-refresh.js': 'analytics-refresh.js',
  'setup/navigation.js': 'setup-navigation.js',
  'setup/tabs.js': '@dustwave/admin-shell/tabs',
  'setup/tabs-browser.js': '@dustwave/admin-shell/tabs-browser',
  'appearance.js': '@dustwave/admin-shell/appearance-browser',
  'setup/turnstile-size.js': '@dustwave/admin-shell/turnstile-browser'
};
for (const [name, source] of Object.entries(files)) {
  await mkdir(dirname(join(temp, name)), { recursive: true });
  await copyFile(
    source.startsWith('@') ? fileURLToPath(import.meta.resolve(source)) : join(root, 'public', source),
    join(temp, name)
  );
}
const destination = join(dir, 'worker-assets');
await rm(destination, { recursive: true, force: true });
await rename(temp, destination);
