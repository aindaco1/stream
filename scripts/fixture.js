import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const file = resolve(process.argv[2] || '.local/clock.mp4');
mkdirSync(dirname(file), { recursive: true });
// FFmpeg's test pattern includes a running clock. The tone changes after the preview.
const result = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-n',
  '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:decimals=2',
  '-f', 'lavfi', '-i', 'aevalsrc=0.07*sin(2*PI*if(lt(t\\,10)\\,440\\,880)*t):s=48000',
  '-t', '136', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
  '-crf', '27', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0', '-bf', '0',
  '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', file
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
