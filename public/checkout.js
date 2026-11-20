import { calculatePlatformTip } from './platform-tip.js';

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
  const statusHome = status.parentElement;
  const hours = Number(document.body.dataset.rentalHours) || 48;
  const rentalLength = value => value + (value === 1 ? ' hour' : ' hours');
  const accessTools = byId('access-tools');
  const restoreTools = byId('restore-tools');
  restoreTools.hidden = document.body.dataset.emailRecovery !== 'true';
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
  const knownRental = slot && read('localStorage', slot + ':rent');
  const activeKind = kinds.includes(attempts.active) ? attempts.active : 'rent';
  const tip = byId('tip-percent');
  // Orders opened before tips were available have a token and a zero tip.
  const priorTip = validToken(attempts[activeKind]) ? (attempts[activeKind + 'Tip'] ?? 0) : tip.defaultValue;
  tip.value = String(attempts.selectedTip ?? priorTip);
  const starts = new Map();
  const address = new URL(location.href);
  const returnId = address.searchParams.get('order');
  const authSlot = id => 'stream:authentication:' + film + ':' + id;
  let returned;
  if (returnId) {
    try { returned = JSON.parse(read('sessionStorage', authSlot(returnId))); } catch { /* The original player owns the attempt. */ }
    for (const key of ['order', 'redirect_status', 'payment_intent', 'payment_intent_client_secret']) address.searchParams.delete(key);
    history.replaceState(history.state, '', address.pathname + address.search);
  }
  let token = [returnedToken, ...(returnId ? [returned?.token] : [knownPurchase, attempts[activeKind], knownRental])].find(validToken);
  if (returnId && token && kinds.includes(returned?.kind)) {
    attempts[returned.kind] = token;
    attempts.active = returned.kind;
    write('sessionStorage', slot, JSON.stringify(attempts));
  }
  if (returnId && !token) status.textContent = 'Return to the original film player and select Check payment after bank verification.';
  let unlocked;
  let generation = 0;
  let instance;
  let checking;
  let timer;
  let delay = 0;
  const delays = [1500, 3000, 5000, 8000, 12000, 20000, 30000];

  function persist() { write('sessionStorage', slot, JSON.stringify(attempts)); }

  function startOrder(kind, attempt, percent) {
    if (starts.has(attempt)) return starts.get(attempt);
    const opening = postToken(film, kind === 'rent' ? 'checkout' : 'buy', attempt + (percent ? ' ' + percent : ''))
      .then(result => {
        if (attempts[kind] === attempt) {
          attempts[kind + 'Opened'] = attempt;
          persist();
        }
        return result;
      }).finally(() => starts.delete(attempt));
    starts.set(attempt, opening);
    return opening;
  }

  function closeForm() {
    generation++;
    instance?.destroy();
    instance = undefined;
    payment.hidden = true;
    document.body.classList.remove('paying');
    byId('stripe-checkout').replaceChildren();
    if (status.parentElement !== statusHome) statusHome.append(status);
  }

  function showOffer() {
    const available = offers.filter(kind => !unlocked || (unlocked.kind === 'rent' && kind === 'buy'));
    check.hidden = !payment.hidden || !token || token === unlocked?.token;
    panel.hidden = !available.length && check.hidden;
    byId('tip-choice').hidden = !available.length;
    byId('tip-value').textContent = tip.value + '%';
    tip.setAttribute('aria-valuetext', tip.value + ' percent');
    for (const kind of kinds) {
      const button = byId(kind);
      button.hidden = !available.includes(kind);
      if (!button.hidden) {
        const action = kind === 'buy' ? 'Buy' : 'Rent';
        const price = Number(document.body.dataset[kind]);
        button.textContent = action + ' · ' + currency.format((price + calculatePlatformTip(price, Number(tip.value))) / 100);
        button.disabled = !payment.hidden;
      }
    }
    const terms = [];
    if (available.includes('rent')) terms.push('Rent for ' + rentalLength(hours) + ' from payment.');
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
        const buying = result.kind === 'buy';
        write('localStorage', slot && slot + (buying ? ':purchase' : ':rent'), attempt);
        ownership.hidden = !buying;
        accessTools.hidden = false;
        restoreTools.hidden = true;
        byId('save-label').textContent = buying ? 'Save purchase link' : 'Watch on another device';
        accessTools.querySelector('label').textContent = buying ? 'Private purchase link' : 'Private rental link';
        byId('access-link').value = location.origin + '/embed/' + encodeURIComponent(film) + '#attempt=' + attempt;
        byId('rental-end').textContent = !buying && result.expiresAt ? 'Rental ends ' + new Date(result.expiresAt * 1000).toLocaleString() + '.' : '';
        if (result.title) byId('film-title').textContent = result.title;
        showOffer();
        if (changed) onPaid(result, watchNow);
      } else if (['expired', 'revoked', 'suspended'].includes(result.status)) {
        closeForm();
        if (unlocked?.token === attempt) {
          unlocked = undefined;
          byId('access-link').value = '';
          ownership.hidden = accessTools.hidden = true;
          document.dispatchEvent(new Event('stream-access-ended'));
        }
        restoreTools.hidden = document.body.dataset.emailRecovery !== 'true';
        if (result.status !== 'suspended') {
          for (const suffix of [':purchase', ':rent']) {
            if (read('localStorage', slot + suffix) === attempt) write('localStorage', slot + suffix, null);
          }
          for (const kind of kinds) if (attempts[kind] === attempt) delete attempts[kind];
        }
        persist();
        token = result.status === 'suspended' ? attempt : unlocked?.token;
        status.textContent = result.status === 'suspended' ? 'Access is paused while the payment is disputed. You can check again later.' :
          result.status === 'revoked' ? 'Access has ended for this payment.' : 'This payment or rental has expired.';
        showOffer();
      } else if (result.status === 'pending') {
        if (manual || delay >= delays.length) {
          check.hidden = false;
          status.textContent = 'Payment is pending. Finish checkout or check again in a moment.';
        }
      } else throw new Error('Order unavailable');
    } catch {
      if (attempt === token) {
        check.hidden = false;
        status.textContent = 'Payment status is unavailable. Select Check payment to try again.';
      }
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
    const percent = Number(tip.value);
    const previous = attempts[kind];
    delay = 0;
    payment.hidden = false;
    document.body.classList.add('paying');
    window.scrollTo(0, 0);
    const heading = byId('checkout-heading');
    heading.textContent = byId('film-title').textContent;
    byId('order-terms').textContent = kind === 'rent' ? 'Test rental · ' + rentalLength(hours) + ' from payment' : 'Test purchase · Watch and download';
    byId('order-price').textContent = '';
    byId('order-tip').hidden = true;
    byId('payment-feedback').append(status);
    heading.focus({ preventScroll: true });
    showOffer();
    status.textContent = 'Opening secure test checkout…';
    clearTimeout(timer);
    try {
      if (validToken(previous) && Number(attempts[kind + 'Tip'] || 0) !== percent) {
        // A closed form can still be waiting for Stripe to open the session.
        // Resolve its outcome before replacing the viewer's only recovery token.
        if (attempts[kind + 'Opened'] !== previous) await startOrder(kind, previous, Number(attempts[kind + 'Tip'] || 0));
        else await starts.get(previous);
        if (run !== generation) return;
        const prior = await postToken(film, 'abandon', previous);
        if (run !== generation) return;
        if (prior.status !== 'expired') {
          token = previous;
          if (prior.status === 'paid') { await inspect(true, true); return; }
          closeForm();
          showOffer();
          status.textContent = 'Your earlier payment is still processing. Check payment before trying again.';
          schedule();
          return;
        }
        delete attempts[kind];
      }
      const attempt = token = validToken(attempts[kind]) ? attempts[kind] : newToken();
      attempts[kind] = attempt;
      attempts[kind + 'Tip'] = percent;
      attempts.active = kind;
      persist();
      const result = await startOrder(kind, attempt, percent);
      if (run !== generation) return;
      if (result.status === 'paid') { await inspect(true, true); return; }
      if (!result.clientSecret || !result.publishableKey || !result.account) throw new Error('Checkout unavailable');
      if (kind === 'rent' && Number.isInteger(result.rentalHours)) byId('order-terms').textContent =
        'Test rental · ' + rentalLength(result.rentalHours) + ' from payment';
      if (typeof result.title === 'string' && result.title) heading.textContent = result.title;
      if (result.currency === 'usd' && Number.isSafeInteger(result.amount) && result.amount > 0) {
        byId('order-price').textContent = currency.format(result.amount / 100);
      }
      if (result.tipAmount > 0) {
        byId('order-tip').textContent = 'Film ' + currency.format(result.filmAmount / 100) + ' + Dust Wave tip ' + currency.format(result.tipAmount / 100);
        byId('order-tip').hidden = false;
      }
      const [, card] = await Promise.all([stripeScript(), result.uiMode === 'elements' ? import('/payment.js') : undefined]);
      if (run !== generation) return;
      const stripe = window.Stripe(result.publishableKey, { stripeAccount: result.account });
      const complete = () => {
        if (run !== generation) return;
        delay = 0;
        inspect(true, true);
      };
      let form;
      if (result.uiMode === 'elements') {
        if (result.kind !== kind || result.currency !== 'usd' || !Number.isSafeInteger(result.amount) || result.amount < 1 ||
            typeof result.title !== 'string' || !result.title || !/^[A-Za-z0-9_-]{1,128}$/.test(result.orderId || '')) {
          throw new Error('Invalid offer');
        }
        write('sessionStorage', authSlot(result.orderId), JSON.stringify({ kind, token: attempt }));
        form = card.createCardForm(stripe, result, schedule, complete);
      } else if (result.uiMode === 'embedded_page' || !result.uiMode) {
        schedule();
        form = await stripe.createEmbeddedCheckoutPage({ fetchClientSecret: async () => result.clientSecret, onComplete: complete });
      } else throw new Error('Unknown checkout type');
      if (run !== generation) { form.destroy(); return; }
      instance = form;
      await form.mount('#stripe-checkout');
      if (run === generation) status.textContent = '';
    } catch {
      if (run !== generation) return;
      closeForm();
      showOffer();
      status.textContent = 'Checkout could not open. Select your offer to try again or check an earlier payment.';
    }
  }

  for (const kind of kinds) byId(kind).addEventListener('click', () => open(kind));
  tip.addEventListener('input', () => {
    attempts.selectedTip = Number(tip.value);
    persist();
    showOffer();
  });
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
      status.textContent = 'Private access link copied.';
    } catch {
      field.focus();
      field.select();
      status.textContent = 'Copy the selected link and keep it somewhere private.';
    }
  });
  byId('restore-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await postToken(film, 'restore', byId('restore-email').value);
      byId('restore-feedback').textContent = 'If this email has access, a private link will arrive shortly. It is valid for 15 minutes.';
    } catch { byId('restore-feedback').textContent = 'Could not request a link. Please try again.'; }
    finally { button.disabled = false; }
  });
  if (token) {
    showOffer();
    inspect(true, Boolean(returnId));
  }
  return { showOffer, purchaseReceipt, checkAccess: () => inspect(true),
    async restoreAttempt(attempt) {
      if (!validToken(attempt)) throw new Error('Invalid link');
      token = attempt;
      await inspect(true, true);
    },
    savePosition(seconds) {
      if (unlocked) fetch('/film/' + encodeURIComponent(film) + '/position', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: unlocked.token + ' ' + seconds,
        credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true
      }).catch(() => {});
    }
  };
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
