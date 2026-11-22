import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mediaProcess } from '../src/media-process.js';
import { liveSalesTerritory } from '../src/marketplace-checkout.js';

const workspace = process.env.STREAM_WORKSPACE_ORIGIN, viewer = process.env.STREAM_VIEWER_ORIGIN;
const children = [];
let stopping = false, status = 425, failure = '';
const readiness = createServer((req,res) => {
  if (req.method !== 'GET' || req.url !== '/ready') return res.writeHead(404).end();
  const headers = {'Cache-Control':'no-store','Content-Type':'text/plain'};
  if (status === 204) {
    headers['Stream-Release'] = process.env.STREAM_RUNTIME_RELEASE;
    headers['Stream-Sales-Territory'] = liveSalesTerritory(process.env.STREAM_SALES_TERRITORIES);
  }
  res.writeHead(status,headers).end(failure);
});
readiness.listen(8791,'0.0.0.0');

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  readiness.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code),5000).unref();
}
function failed(message) {
  if (stopping || status === 503) return;
  status = 503;
  failure = message.slice(0,360);
  // Only the operator's readiness binding can read this port. Give it a chance
  // to collect a startup diagnostic before the failed container is recycled.
  setTimeout(() => stop(1),15000).unref();
}
function start(file,origin,port) {
  const child = spawn(process.execPath,['src/' + file],{ stdio:'inherit',env:{
    ...process.env,PORT:String(port),STREAM_PUBLIC_ORIGIN:origin
  } });
  children.push(child);
  child.once('error',() => failed(file+' did not start.'));
  child.once('exit',(code) => failed(file+' exited ('+code+').'));
}
process.on('SIGTERM',() => stop(0));
process.on('SIGINT',() => stop(0));

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

async function boot() {
  // Render one known frame through the same isolated source/proxy path as a film.
  // The image contains the synthetic original. No account or external media is used.
  const fixture = await readFile(new URL('./probe.mp4',import.meta.url));
  const pixels = await mediaProcess({read: async (head,start,end) => fixture.subarray(start,end)},
    {size:fixture.length}, 'mov', {after:['-frames:v','1','-threads:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],
      maxRead:128 * 1024, maxOutput:1024, timeout:10000, checkSandbox:true,
      // The only input is our shipped fixture. Never collect decoder logs for viewer content.
      onFailure:error => failed('Isolated renderer: ' + String(error.stderr || error.code || error.message).trim())});
  if (pixels.length !== 256 || !pixels.every(pixel => pixel >= 230)) throw Error('Isolated frame did not decode.');
  start('server.js',workspace,8792);
  start('viewer-server.js',viewer,8793);
  for (let i=0; !stopping && status !== 503 && i<100; i++) {
    try {
      await Promise.all([listening(8792,workspace),listening(8793,viewer)]);
      status = 204;
      return;
    } catch { await new Promise(resolve => setTimeout(resolve,250)); }
  }
  failed('Application listeners did not become ready.');
}
boot().catch(() => failed('Isolated media startup check failed.'));
