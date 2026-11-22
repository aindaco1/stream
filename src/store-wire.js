// Only the private Container outbound binding can invoke this contract.
// Keep methods that return closures local to the service that owns the ledger.
export function callStore(store, method, args) {
  if (typeof method !== 'string' || !Array.isArray(args)) throw new TypeError('Invalid store call.');
  if (method === 'probe.get' || method === 'probe.set') {
    const [owner, film, ...rest] = args;
    return store.filmProbeCache(owner, film)[method.slice(6)](...rest);
  }
  if (method.startsWith('stripe.')) {
    const [owner, mode, expected, stateOrAccount, requestedMode] = args;
    const ctx = store.stripeContext(owner, mode);
    if (method === 'stripe.read') return { creatorId:ctx.creatorId, state:ctx.state, confirmation:ctx.confirmation };
    if (ctx.confirmation !== expected) throw Object.assign(new Error('Stripe setup changed. Reload the setup card to continue.'), {
      name:'StripeSetupError', statusCode:409
    });
    if (method === 'stripe.assert') return ctx.assertCurrent();
    if (method === 'stripe.claim') return ctx.claimAccount(stateOrAccount, requestedMode);
    if (method === 'stripe.save') {
      for (const key of Object.keys(ctx.state)) delete ctx.state[key];
      Object.assign(ctx.state, stateOrAccount);
      ctx.save();
      return ctx.confirmation;
    }
    throw new TypeError('Unknown Stripe setup operation.');
  }
  if (['close','stripeContext','filmProbeCache'].includes(method) ||
      !Object.hasOwn(store, method) || typeof store[method] !== 'function') throw new TypeError('Unknown store method.');
  return store[method](...args);
}

// Structured clone over the private HTTP hop. Containers send plain JSON film
// records, Maps of published offers, optional arguments and binary hash inputs.
export function pack(value) {
  if (value === undefined) return ['void'];
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) return ['map', [...value].map(([k,v]) => [pack(k),pack(v)])];
  if (value instanceof Uint8Array) return ['bytes', Array.from(value)];
  if (Array.isArray(value)) return ['list',value.map(pack)];
  return ['object',Object.entries(value).map(([k,v]) => [k,pack(v)])];
}
export function unpack(value) {
  if (!Array.isArray(value)) return value;
  const [kind,data] = value;
  if (kind === 'void') return undefined;
  if (kind === 'bytes') return Uint8Array.from(data);
  if (kind === 'list') return data.map(unpack);
  if (kind === 'map') return new Map(data.map(([k,v]) => [unpack(k),unpack(v)]));
  if (kind === 'object') return Object.fromEntries(data.map(([k,v]) => [k,unpack(v)]));
  throw new TypeError('Invalid store reply.');
}
