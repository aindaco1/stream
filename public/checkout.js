const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const kinds = ['rent', 'buy'];
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let scriptPromise;

function stripeScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/endive/stripe.js';
    script.referrerPolicy = 'origin';
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      scriptPromise = undefined;
      reject(new Error('Stripe unavailable'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

function read(store, key) {
  try { return window[store].getItem(key); } catch { return null; }
}

function write(store, key, value) {
  if (!key) return;
  try {
    if (value === null) window[store].removeItem(key);
    else window[store].setItem(key, value);
  } catch { /* Storage can be disabled in a publisher's iframe. */ }
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function postToken(film, path, token) {
  const response = await fetch('/film/' + encodeURIComponent(film) + '/' + path, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token,
    credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Request unavailable');
  return response.json();
}

// Window.length and indexed child windows are readable across origins. Scope
// storage by position so two copies of a film can run separate checkouts.
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

export function attachViewerCheckout(film, returnedToken, onPaid) {
  const byId = id => document.getElementById(id);
  const panel = byId('purchase');
  const payment = byId('payment');
  const ownership = byId('ownership');
  const status = byId('status');
  const check = byId('check-payment');
  const download = byId('download');
  const target = document.createElement('iframe');
  target.title = 'File download';
  target.hidden = true;
  const offers = kinds.filter(kind => /^[1-9]\d*$/.test(document.body.dataset[kind]));
  let slot;
  try { slot = viewerSlot(film); } catch { /* An isolated frame can still use memory. */ }
  const saved = slot && read('sessionStorage', slot);
  let attempts = {};
  try { attempts = JSON.parse(saved) || {}; } catch { /* Earlier players stored just a rental token. */ }
  if (validToken(saved)) attempts = { rent: saved, active: 'rent' };
  const knownPurchase = slot && read('localStorage', slot + ':purchase');
  const activeKind = kinds.includes(attempts.active) ? attempts.active : 'rent';
  let token = [returnedToken, knownPurchase, attempts[activeKind]].find(validToken);
  let unlocked;
  let generation = 0;
  let instance;
  let checking;
  let timer;
  let delay = 0;
  const delays = [1500, 3000, 5000, 8000, 12000, 20000, 30000];

  function persist() { write('sessionStorage', slot, JSON.stringify(attempts)); }

  function closeForm() {
    generation++;
    instance?.destroy();
    instance = undefined;
    payment.hidden = true;
    document.body.classList.remove('paying');
    byId('stripe-checkout').replaceChildren();
  }

  function showOffer() {
    const available = offers.filter(kind => !unlocked || (unlocked.kind === 'rent' && kind === 'buy'));
    check.hidden = !token || token === unlocked?.token;
    panel.hidden = !available.length && check.hidden;
    for (const kind of kinds) {
      const button = byId(kind);
      button.hidden = !available.includes(kind);
      if (!button.hidden) {
        const action = kind === 'buy' ? 'Buy' : 'Rent';
        button.textContent = action + ' · ' + currency.format(Number(document.body.dataset[kind]) / 100);
        button.disabled = !payment.hidden;
      }
    }
    const terms = [];
    if (available.includes('rent')) terms.push('Rent for 48 hours from payment.');
    if (available.includes('buy')) terms.push('Buy to watch and download.');
    byId('terms').textContent = available.length ? 'Test checkout. ' + terms.join(' ') : '';
  }

  function schedule() {
    clearTimeout(timer);
    if (token && token !== unlocked?.token && delay < delays.length) {
      timer = setTimeout(() => inspect(false), delays[delay++]);
    }
  }

  async function inspect(manual, startPlayback = false) {
    const attempt = token;
    if (!attempt || checking === attempt) return;
    checking = attempt;
    check.disabled = true;
    clearTimeout(timer);
    if (manual) status.textContent = 'Checking your payment…';
    try {
      const result = await postToken(film, 'order', attempt);
      if (attempt !== token) return;
      if (result.status === 'paid' && kinds.includes(result.kind) && typeof result.receipt === 'string' && result.receipt) {
        const changed = unlocked?.token !== attempt;
        const watchNow = startPlayback || !payment.hidden;
        closeForm();
        unlocked = { token: attempt, kind: result.kind };
        attempts[result.kind] = attempt;
        attempts.active = result.kind;
        persist();
        if (result.kind === 'buy') {
          write('localStorage', slot && slot + ':purchase', attempt);
          ownership.hidden = false;
          byId('access-link').value = location.origin + '/embed/' + encodeURIComponent(film) + '#attempt=' + attempt;
        }
        showOffer();
        if (changed) onPaid(result, watchNow);
      } else if (result.status === 'expired') {
        closeForm();
        if (read('localStorage', slot + ':purchase') === attempt) write('localStorage', slot + ':purchase', null);
        for (const kind of kinds) if (attempts[kind] === attempt) delete attempts[kind];
        persist();
        token = unlocked?.token;
        status.textContent = 'This payment or rental has expired. Choose an offer to start again.';
        showOffer();
      } else if (result.status === 'pending') {
        if (manual || delay >= delays.length) status.textContent = 'Payment is pending. Finish checkout or check again in a moment.';
      } else throw new Error('Order unavailable');
    } catch {
      if (attempt === token) status.textContent = 'Payment status is unavailable. Select Check payment to try again.';
    } finally {
      if (checking === attempt) {
        checking = undefined;
        check.disabled = false;
        schedule();
      }
    }
  }

  async function open(kind) {
    closeForm();
    const run = generation;
    token = validToken(attempts[kind]) ? attempts[kind] : newToken();
    const attempt = token;
    attempts[kind] = attempt;
    attempts.active = kind;
    persist();
    delay = 0;
    payment.hidden = false;
    document.body.classList.add('paying');
    window.scrollTo(0, 0);
    const heading = byId('checkout-heading');
    heading.textContent = kind === 'rent' ? 'Rent this film' : 'Buy this film';
    heading.focus({ preventScroll: true });
    showOffer();
    status.textContent = 'Opening secure test checkout…';
    schedule();
    try {
      const result = await postToken(film, kind === 'rent' ? 'checkout' : 'buy', attempt);
      if (run !== generation) return;
      if (result.status === 'paid') { await inspect(true, true); return; }
      if (!result.clientSecret || !result.publishableKey || !result.account) throw new Error('Checkout unavailable');
      await stripeScript();
      if (run !== generation) return;
      const stripe = window.Stripe(result.publishableKey, { stripeAccount: result.account });
      const form = await stripe.createEmbeddedCheckoutPage({
        fetchClientSecret: async () => result.clientSecret,
        onComplete: () => { if (run === generation) { delay = 0; inspect(true, true); } }
      });
      if (run !== generation) { form.destroy(); return; }
      instance = form;
      form.mount('#stripe-checkout');
      status.textContent = 'Complete payment here. Your film will start when payment is confirmed.';
    } catch {
      if (run !== generation) return;
      closeForm();
      showOffer();
      status.textContent = 'Checkout could not open. Select your offer to try again or check an earlier payment.';
    }
  }

  for (const kind of kinds) byId(kind).addEventListener('click', () => open(kind));
  check.addEventListener('click', () => inspect(true, true));
  byId('close-checkout').addEventListener('click', () => {
    const button = byId(attempts.active);
    closeForm();
    showOffer();
    button?.focus();
    status.textContent = 'Checkout closed. You can resume the same offer or check your payment.';
  });

  async function purchaseReceipt() {
    if (unlocked?.kind !== 'buy') throw new Error('Purchase unavailable');
    const order = await postToken(film, 'order', unlocked.token);
    if (order.status !== 'paid' || order.kind !== 'buy' || !order.receipt) throw new Error('Purchase unavailable');
    return order.receipt;
  }

  download.action = '/film/' + encodeURIComponent(film) + '/download';
  target.name = 'stream-file-' + newToken().slice(0, 16);
  download.target = target.name;
  download.addEventListener('submit', async event => {
    event.preventDefault();
    const button = download.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      download.elements.receipt.value = await purchaseReceipt();
      if (!target.isConnected) ownership.append(target);
      HTMLFormElement.prototype.submit.call(download);
      status.textContent = 'Your file download is starting.';
    } catch {
      status.textContent = 'Your download could not start. Check your connection and try again.';
    } finally {
      download.elements.receipt.value = '';
      button.disabled = false;
    }
  });
  target.addEventListener('load', () => {
    if (target.contentDocument?.URL.startsWith(location.origin + '/film/')) {
      status.textContent = 'The file is unavailable. Try Download film again.';
    }
  });
  byId('copy-link').addEventListener('click', async () => {
    const field = byId('access-link');
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = 'Private purchase link copied.';
    } catch {
      field.focus();
      field.select();
      status.textContent = 'Copy the selected link and keep it somewhere private.';
    }
  });
  if (token) {
    showOffer();
    inspect(true);
  }
  return { showOffer, purchaseReceipt };
}

// Keep old checkout bookmarks and outstanding hosted-session returns usable.
if (document.body.dataset.page === 'pay') {
  const film = location.pathname.split('/')[2];
  const token = location.hash.slice(1);
  if (/^[a-z0-9-]+$/.test(film)) location.replace('/embed/' + film + (validToken(token) ? '#attempt=' + token : ''));
}
if (document.body.dataset.page === 'return') {
  try {
    const old = JSON.parse(read('sessionStorage', 'stream:checkout-return'));
    if (typeof old?.film === 'string' && /^[a-z0-9-]+$/.test(old.film) && validToken(old.token)) {
      const link = document.querySelector('#return-film');
      link.href = '/embed/' + old.film + '#attempt=' + old.token;
      link.textContent = 'Return to film';
    }
  } catch { /* The screening room is the fallback for older, closed tabs. */ }
}
