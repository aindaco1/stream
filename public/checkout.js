const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validFilm = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value);
const returnKey = 'stream:checkout-return';

function read(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function save(key, value) {
  if (!key) return;
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* The current page still holds its checkout attempt in memory. */ }
}

function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function postToken(film, path, token) {
  const response = await fetch('/film/' + encodeURIComponent(film) + '/' + path, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token,
    credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Request unavailable');
  return response.json();
}

// The position is readable across origins through Window.length and indexed
// child Window references. It survives a publisher reload and separates two
// copies of the same film without requiring embed IDs from the publisher.
function viewerSlot(film) {
  const position = [];
  let child = window;
  while (child !== child.parent) {
    const parent = child.parent;
    let index = 0;
    while (index < parent.length && parent[index] !== child) index++;
    position.unshift(index);
    child = parent;
  }
  const publisher = document.referrer ? new URL(document.referrer).origin : '';
  return 'stream:order:' + film + ':' + publisher + ':' + position.join('.');
}

export function attachViewerCheckout(film, returnedAttempt, onPaid) {
  const panel = document.querySelector('#purchase');
  const rent = document.querySelector('#rent');
  const check = document.querySelector('#check-payment');
  const here = document.querySelector('#checkout-here');
  const status = document.querySelector('#status');
  let slot;
  try { slot = viewerSlot(film); } catch { /* A restricted iframe can still pay in memory. */ }
  const saved = slot && read(slot);
  let token = validToken(returnedAttempt) ? returnedAttempt : validToken(saved) ? saved : null;
  let checking = false;
  let unlocked = false;
  let timer;
  let nextDelay = 0;
  const delays = [1200, 2500, 5000, 8000, 12000, 20000, 30000];

  function offer() {
    if (unlocked) return;
    panel.hidden = false;
    rent.textContent = token ? 'Reopen test checkout' : 'Start test rental';
    check.hidden = here.hidden = !token;
    if (token) here.href = '/pay/' + encodeURIComponent(film) + '#' + token;
    else here.removeAttribute('href');
  }

  function schedule() {
    clearTimeout(timer);
    if (token && !unlocked && nextDelay < delays.length) {
      timer = setTimeout(() => inspect(false), delays[nextDelay++]);
    }
  }

  async function inspect(manual) {
    if (!token || checking || unlocked) return;
    clearTimeout(timer);
    checking = true;
    check.disabled = true;
    const attempt = token;
    if (manual) status.textContent = 'Checking your payment…';
    try {
      const order = await postToken(film, 'order', attempt);
      if (attempt !== token) return;
      if (order.status === 'paid' && typeof order.receipt === 'string' && order.receipt) {
        unlocked = true;
        panel.hidden = true;
        here.removeAttribute('href');
        onPaid(order.receipt);
      } else if (order.status === 'expired') {
        token = null;
        save(slot, null);
        offer();
        status.textContent = 'This checkout or rental has expired. You can start a new rental.';
      } else if (order.status === 'pending') {
        if (manual || nextDelay >= delays.length) status.textContent = 'Payment is pending. Finish checkout, then select Check payment.';
      } else throw new Error('Order unavailable');
    } catch {
      status.textContent = 'Payment status is unavailable. Select Check payment to try again.';
    } finally {
      checking = false;
      check.disabled = false;
      schedule();
    }
  }

  rent.addEventListener('click', () => {
    token ??= randomId(32);
    save(slot, token);
    offer();
    status.textContent = 'Finish test checkout in the new tab. If it did not open, use this tab for checkout.';
    // Browsers can return null for a successful noopener navigation.
    try { window.open(here.href, '_blank', 'noopener,noreferrer'); }
    catch { /* The same-tab link remains available. */ }
    nextDelay = 0;
    schedule();
  });
  check.addEventListener('click', () => inspect(true));
  if (token) {
    save(slot, token);
    offer();
    status.textContent = 'Checking your rental…';
    inspect(true);
  }
  return { showOffer: offer };
}

function savedReturn() {
  try {
    const entry = JSON.parse(read(returnKey));
    if (validFilm(entry?.film) && validToken(entry?.token)) return entry;
  } catch { /* A fresh checkout tab has no return information. */ }
  return null;
}

function returnLink(film, token) {
  const link = document.querySelector('#return-film');
  link.href = '/embed/' + encodeURIComponent(film) + (token ? '#attempt=' + token : '');
  link.hidden = false;
}

function startCheckout() {
  const film = location.pathname.split('/')[2];
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, '', location.pathname);
  const status = document.querySelector('#status');
  const retry = document.querySelector('#retry');
  if (!validFilm(film) || self !== top) {
    status.textContent = 'Open checkout from the film in a new tab.';
    return;
  }
  const saved = savedReturn();
  const token = fragment || (saved?.film === film && saved.token);
  if (!validToken(token)) {
    status.textContent = 'Open the film and start a rental to reach checkout.';
    returnLink(film, null);
    return;
  }
  save(returnKey, JSON.stringify({ film, token }));
  returnLink(film, token);

  async function openStripe() {
    retry.hidden = true;
    status.textContent = 'Opening Stripe test checkout…';
    try {
      const { url } = await postToken(film, 'checkout', token);
      const target = new URL(url);
      const returning = target.href === location.origin + '/checkout/return';
      if (!returning && (target.origin !== 'https://checkout.stripe.com' || target.username || target.password)) {
        throw new Error('Invalid checkout');
      }
      location.replace(target.href);
    } catch {
      status.textContent = 'Checkout could not open. Try again or return to the film to check your payment.';
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', openStripe);
  openStripe();
}

if (document.body.dataset.page === 'pay') startCheckout();
if (document.body.dataset.page === 'return') {
  const saved = savedReturn();
  if (saved) returnLink(saved.film, saved.token);
}
