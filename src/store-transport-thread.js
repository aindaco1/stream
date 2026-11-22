import { parentPort, workerData } from 'node:worker_threads';
import { pack, unpack } from './store-wire.js';

const { notify, channel, endpoint, token } = workerData;
parentPort.on('message', async ({ id, method, args }) => {
  let result;
  try {
    const response = await fetch(endpoint, { method:'POST', redirect:'error', signal:AbortSignal.timeout(12_000),
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
      body:JSON.stringify({ method, args:pack(args) })
    });
    if (!response.ok) throw new Error('Stream storage is temporarily unavailable.');
    const reply = await response.json();
    result = reply.error ? { error:reply.error } : { value:unpack(reply.value) };
  } catch { result = { error:{ message:'Stream storage is temporarily unavailable.' } }; }
  channel.postMessage({ id,...result });
  Atomics.add(notify, 0, 1);
  Atomics.notify(notify, 0);
});
