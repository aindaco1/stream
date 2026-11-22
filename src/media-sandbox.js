import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('../deploy/media-relay.py', import.meta.url));

export async function mediaTransport(server, tool, checkSandbox = false) {
  const isolated = process.env.STREAM_MEDIA_SANDBOX;
  if (!isolated && process.env.STRIPE_CONNECT_LIVE !== '1') {
    await listen(0, '127.0.0.1');
    return { executable: tool, prefix: [], proxy: 'http://127.0.0.1:' + server.address().port };
  }
  if (isolated !== 'bubblewrap' || process.platform !== 'linux') {
    throw new Error('Live media needs a Linux media sandbox.');
  }
  const dir = await mkdtemp(join(tmpdir(), 'stream-job-'));
  const socket = join(dir, 'source.sock');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await listen(socket);
  } catch (error) { await cleanup(); throw error; }
  // This job gets a separate network and PID namespace, read-only OS libraries
  // and one input socket. The host's state, other jobs and credentials are absent.
  return { executable: '/usr/bin/setpriv', proxy: 'http://127.0.0.1:17823', cleanup, prefix: [
    '--no-new-privs', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--', '/usr/bin/bwrap',
    '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--setenv', 'LC_ALL', 'C', '--setenv', 'PATH', '/usr/bin',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--dir', '/dev', '--dev-bind', '/dev/null', '/dev/null',
    '--dev-bind', '/dev/urandom', '/dev/urandom', '--size', '16777216', '--tmpfs', '/tmp',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives', '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--ro-bind', socket, '/input.sock', '--ro-bind', relay, '/relay.py',
    '--', '/usr/bin/python3', '-I', '/relay.py', ...(checkSandbox ? ['--check-sandbox'] : []), tool
  ] };

  function listen(...address) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(...address, () => { server.off('error', reject); resolve(); });
    });
  }
}
