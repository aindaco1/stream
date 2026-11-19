import { openFilm, revisionFor } from './media.js';
import { savedFilmScope } from './rental.js';
import { BLOCK_SIZE, createR2Source } from './source.js';
import { filmPrices } from './prices.js';
import { stripeSetupStateForMode } from './setup-stripe.js';

const filmId = /^f-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerName = /^[a-zA-Z0-9][a-zA-Z0-9 ._@+-]{0,95}$/;
const accountId = /^acct_[a-zA-Z0-9]{3,100}$/;
const unavailable = () => new Error('Film unavailable.');
const badList = () => new Error('Invalid STREAM_PUBLIC_FILMS. Use up to 32 unique saved-film entries with owner and id.');

function parseList(raw) {
  if (!raw) return new Map();
  if (typeof raw !== 'string' || raw.length > 8192) throw badList();
  let items;
  try { items = JSON.parse(raw); } catch { throw badList(); }
  if (!Array.isArray(items) || items.length > 32) throw badList();
  const owners = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 2 ||
        typeof item.owner !== 'string' || !ownerName.test(item.owner) || typeof item.id !== 'string' ||
        !filmId.test(item.id) || owners.has(item.id)) throw badList();
    owners.set(item.id, item.owner);
  }
  return owners;
}

// Only list() produces public metadata. get() and verify() return internal,
// server-side bindings for playback and connected-account checkout.
export function createPublicFilms({ store, env = process.env, authority, platformAccount,
  sourceFor = createR2Source, openMedia = openFilm }) {
  let raw = env.STREAM_PUBLIC_FILMS;
  let configured = parseList(raw);
  function publications() {
    if (env.STREAM_PUBLIC_FILMS !== raw) {
      configured = parseList(env.STREAM_PUBLIC_FILMS);
      raw = env.STREAM_PUBLIC_FILMS;
    }
    return configured;
  }

  function record(id) {
    const owner = publications().get(id);
    if (!owner || !authority || env.STRIPE_CONNECT_LIVE === '1' ||
        !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_CONNECT_SECRET_KEY || '')) return;
    const film = store.film(owner, id);
    if (film?.id !== id || !film.bucket || !film.objectKey || !/^[A-Za-z0-9_-]{43}$/.test(film.revision) ||
        typeof film.title !== 'string' || !film.title.trim() || film.title.length > 160 ||
        typeof film.rights?.version !== 'string' || !film.rights.version.trim() ||
        typeof film.rights.statement !== 'string' || !film.rights.statement.trim() ||
        !Number.isFinite(Date.parse(film.rights.acceptedAt)) || Date.parse(film.rights.acceptedAt) > Date.now()) return;
    const prices = filmPrices(film.prices);
    if (!prices) return;
    const maker = store.maker(owner);
    if (!maker) return;
    const state = stripeSetupStateForMode(maker.stripe, 'test');
    const account = state.accountId;
    if (state.mode !== 'test' || state.creatorId !== owner || !['hosted', 'oauth'].includes(state.channel) ||
        state.status !== 'ready' || state.chargesEnabled !== true || state.payoutsEnabled !== true ||
        !accountId.test(account) || account === platformAccount || !store.ownsTestAccount(owner, account)) return;
    const spec = Object.freeze({ id, title: film.title, owner, account, scope: savedFilmScope(owner, id),
      revision: film.revision, authority, prices });
    return { spec, bucket: film.bucket, objectKey: film.objectKey };
  }

  function requireRecord(id) {
    const entry = record(id);
    if (!entry) throw unavailable();
    return entry;
  }

  function current(entry) {
    const next = requireRecord(entry.spec.id);
    if (next.spec.owner !== entry.spec.owner || next.spec.account !== entry.spec.account ||
        next.spec.revision !== entry.spec.revision || next.objectKey !== entry.objectKey ||
        next.bucket.accountId !== entry.bucket.accountId || next.bucket.jurisdiction !== entry.bucket.jurisdiction ||
        next.bucket.bucket !== entry.bucket.bucket) throw unavailable();
    return next;
  }

  // openFilm calls head() on each render, including when its input index is
  // cached. Use the saved source and the current credential for every new render.
  function privateSource(entry) {
    let reader;
    return {
      async head() {
        const live = current(entry);
        const credentials = store.credentials(live.spec.owner, live.bucket);
        const source = sourceFor({ ...credentials, ...live.bucket, objectKey: live.objectKey });
        const head = await source.head();
        current(entry);
        if (revisionFor(head) !== live.spec.revision) throw unavailable();
        reader = source;
        return head;
      },
      read(head, start, end) { return reader.read(head, start, end); },
      async *stream(head, start, end, signal) {
        if (reader.stream) {
          yield* reader.stream(head, start, end, signal);
          return;
        }
        for (let offset = start; offset < end; offset += BLOCK_SIZE) {
          signal?.throwIfAborted();
          yield await reader.read(head, offset, Math.min(end, offset + BLOCK_SIZE));
        }
      }
    };
  }

  return Object.freeze({
    get(id) { return record(id)?.spec; },
    list() {
      const films = [];
      for (const id of publications().keys()) {
        const entry = record(id);
        if (entry) films.push({ id, title: entry.spec.title });
      }
      return films;
    },
    async verify(id) {
      try {
        const entry = requireRecord(id);
        await privateSource(entry).head();
        return current(entry).spec;
      } catch { throw unavailable(); }
    },
    async download(id, grant) {
      const entry = requireRecord(id);
      const { orderId } = await authority.verifyDownloadGrant(grant, { film: entry.spec.scope, revision: entry.spec.revision });
      const source = privateSource(entry);
      const head = await source.head();
      // The caller rechecks this purchase order before beginning HTTP delivery.
      return {
        size: head.size, title: entry.spec.title, revision: entry.spec.revision, orderId,
        async *stream(start = 0, end = head.size, signal) {
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > head.size) {
            throw new Error('Invalid download range.');
          }
          current(entry);
          let bytes = 0;
          let recheck = 0;
          for await (const chunk of source.stream(head, start, end, signal)) {
            if (bytes >= recheck) {
              current(entry);
              recheck = bytes + 4 * 1024 * 1024;
            }
            bytes += chunk.byteLength;
            if (bytes > end - start) throw unavailable();
            yield chunk;
          }
          if (bytes !== end - start) throw unavailable();
        }
      };
    },
    async open(id) {
      let media;
      try {
        const entry = requireRecord(id);
        media = await openMedia(privateSource(entry));
        current(entry);
        if (media.revision !== entry.spec.revision) throw unavailable();
        return media;
      } catch {
        media?.close();
        throw unavailable();
      }
    }
  });
}
