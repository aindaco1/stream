export function stripeMode(env) {
  if (!['0', '1', undefined].includes(env.STRIPE_CONNECT_LIVE)) throw Error('Invalid STRIPE_CONNECT_LIVE.');
  return env.STRIPE_CONNECT_LIVE === '1' ? 'live' : 'test';
}

export function stripeSecretMode(key) {
  return /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(key)?.[1];
}

export function publishableKeyMode(key) {
  return /^pk_(test|live)_[A-Za-z0-9]+$/.exec(key)?.[1];
}

export function sessionMode(id) {
  return /^cs_(test|live)_[A-Za-z0-9]+$/.exec(id)?.[1];
}
