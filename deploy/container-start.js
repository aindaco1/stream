import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mediaProcess } from '../src/media-process.js';

// Render one known frame through the same isolated source/proxy path as a film.
// The image contains the synthetic original. No account or external media is used.
const fixture = await readFile(new URL('./probe.mp4',import.meta.url));
const pixels = await mediaProcess({read: async (head,start,end) => fixture.subarray(start,end)},
  {size:fixture.length}, 'mov', {after:['-frames:v','1','-threads:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],
    maxRead:128 * 1024, maxOutput:1024, timeout:8000});
if (pixels.length !== 256 || !pixels.every(pixel => pixel >= 230)) throw Error('Isolated media startup check failed.');

const workspace = process.env.STREAM_WORKSPACE_ORIGIN, viewer = process.env.STREAM_VIEWER_ORIGIN;
const children = [];
let stopping = false;
const readiness = createServer((req,res) => {
  res.writeHead(req.method === 'GET' && req.url === '/ready' ? 204 : 404,{'Cache-Control':'no-store'}).end();
});
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  readiness.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code),5000).unref();
}
function start(file,origin,port) {
  const child = spawn(process.execPath,['src/' + file],{ stdio:'inherit',env:{
    ...process.env,PORT:String(port),STREAM_PUBLIC_ORIGIN:origin
  } });
  children.push(child);
  child.once('error',() => stop(1));
  child.once('exit',() => stop(1));
}
process.on('SIGTERM',() => stop(0));
process.on('SIGINT',() => stop(0));
start('server.js',workspace,8792);
start('viewer-server.js',viewer,8793);
function listening(port,origin) {
  return new Promise((resolve,reject) => {
    const request = get({hostname:'127.0.0.1',port,path:'/favicon.svg',headers:{Host:new URL(origin).host},
      signal:AbortSignal.timeout(1500)},response => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(Error('Stream listener not ready.'));
    });
    request.once('error',reject);
  });
}
for (let i=0; !stopping && i<100; i++) {
  try {
    await Promise.all([listening(8792,workspace),listening(8793,viewer)]);
    readiness.listen(8791,'0.0.0.0');
    break;
  } catch {
    if (i === 99) stop(1);
    else await new Promise(resolve => setTimeout(resolve,250));
  }
}
