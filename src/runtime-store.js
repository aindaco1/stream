import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { openSetupStore } from './setup-store.js';
import { StripeSetupError } from './setup-stripe.js';

// Existing route and transaction callbacks use a synchronous store. Run HTTP on
// its own thread, one domain operation per call. All SQL executes atomically in
// the same DO as the edge signup, including when the container is replaced.
export function openRuntimeStore(directory, mode='test') {
  if (process.env.STREAM_STORE_TRANSPORT !== 'durable-object') return openSetupStore(directory, mode);
  if (mode !== 'live' || !process.env.STREAM_STORE_TOKEN) throw Error('Missing live storage configuration.');
  return remoteStore('http://192.0.2.1/call', process.env.STREAM_STORE_TOKEN, mode);
}
export function remoteStore(endpoint, token, mode) {
  const { port1, port2 } = new MessageChannel();
  const notify = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('./store-transport-thread.js', import.meta.url), {
    execArgv:[], workerData:{ endpoint,token,notify,channel:port2 }, transferList:[port2]
  });
  worker.unref();
  let nextId = 0, closed = false;
  function call(method, ...args) {
    if (closed) throw Error('Stream storage has closed.');
    const id = ++nextId, deadline = Date.now() + 15_000;
    worker.postMessage({ id,method,args });
    for (;;) {
      const generation = Atomics.load(notify, 0);
      let packet;
      while ((packet = receiveMessageOnPort(port1))) {
        const reply = packet.message;
        if (reply.id !== id) continue;
        if (!reply.error) return reply.value;
        const details = reply.error;
        const error = details.name === 'StripeSetupError' ? new StripeSetupError(details.message, details.statusCode) : new Error(details.message);
        throw Object.assign(error, details);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Stream storage did not confirm the operation.');
      Atomics.wait(notify, 0, generation, remaining);
    }
  }
  const api = {
    paymentMode:mode,
    close() { closed = true; port1.close(); void worker.terminate(); },
    filmProbeCache(owner,id) {
      return { get:(...args) => call('probe.get',owner,id,...args), set:(...args) => call('probe.set',owner,id,...args) };
    },
    stripeContext(owner,mode) {
      const initial = call('stripe.read',owner,mode);
      let expected = initial.confirmation;
      return { creatorId:initial.creatorId,state:initial.state,
        get confirmation() { return expected; },
        assertCurrent() { call('stripe.assert',owner,mode,expected); },
        claimAccount(account,requestedMode) { return call('stripe.claim',owner,mode,expected,account,requestedMode); },
        save() { expected = call('stripe.save',owner,mode,expected,initial.state); }
      };
    }
  };
  return new Proxy(api, { get(target, field) {
    if (Object.hasOwn(target,field)) return target[field];
    if (typeof field === 'string' && field !== 'then') return (...args) => call(field,...args);
  } });
}
