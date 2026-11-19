import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ options: { feature: { type: 'boolean' } }, allowPositionals: true });
if (positionals.length > 1) throw new Error('Usage: node scripts/fixture.js [--feature] [output.mp4]');
const file = resolve(positionals[0] ?? (values.feature ? '.local/feature-clock.mp4' : '.local/clock.mp4'));
mkdirSync(dirname(file), { recursive: true });

const fps = values.feature ? 12 : 24;
const duration = values.feature ? 90 * 60 : 136;
// The feature tone steps up 60 Hz every 15 minutes after the initial preview cue.
const rentalTone = values.feature ? '660+60*floor(t/900)' : '880';
const sampleRate = values.feature ? 24000 : 48000;
const tone = `aevalsrc=exprs='0.07*sin(2*PI*if(lt(t,10),440,${rentalTone})*t)':s=${sampleRate}`;
const result = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-n',
  '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=' + fps + ':decimals=2',
  '-f', 'lavfi', '-i', tone,
  '-t', String(duration), '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
  '-crf', '27', '-g', String(4 * fps), '-keyint_min', String(4 * fps), '-sc_threshold', '0', '-bf', '0',
  '-c:a', 'aac', '-b:a', values.feature ? '32k' : '48k', '-movflags', '+faststart', file
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
