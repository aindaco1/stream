import { isProgramId, validRights } from './program-store.js';
import { programCatalog } from './program-catalog.js';
import { openFilm, revisionFor } from './media.js';
import { createThumbnails } from './thumbnails.js';
import { savedFilmScope } from './rental.js';
import { BLOCK_SIZE, createR2Source, PrivateOriginalUnavailable, videoContentType } from './source.js';
import { filmPrices, previewSeconds, rentalHours } from './prices.js';
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
  sourceFor = createR2Source, openMedia = openFilm, thumbnails = createThumbnails(store) }) {
  let raw = env.STREAM_PUBLIC_FILMS;
  let configured = parseList(raw);
  function publications() {
    if (env.STREAM_PUBLIC_FILMS !== raw) {
      configured = parseList(env.STREAM_PUBLIC_FILMS);
      raw = env.STREAM_PUBLIC_FILMS;
    }
    return configured;
  }

  function publicationOwner(id, entitled = false) {
    const listed = publications().get(id);
    const choice = store.filmPublication(id);
    if (choice) return choice.published || (entitled && store.priorOrderOwner(id) === choice.owner) ? choice.owner : undefined;
    return listed ?? (entitled ? store.priorOrderOwner(id) : undefined);
  }
  const sandbox = () => env.STRIPE_CONNECT_LIVE !== '1' && /^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_CONNECT_SECRET_KEY || '');
  function seller(owner) {
    const maker = store.maker(owner);
    if (!maker) return;
    const state = stripeSetupStateForMode(maker.stripe, 'test');
    const account = state.accountId;
    if (state.mode === 'test' && state.creatorId === owner && ['hosted', 'oauth'].includes(state.channel) &&
        state.status === 'ready' && state.chargesEnabled === true && state.payoutsEnabled === true &&
        accountId.test(account) && account !== platformAccount && store.ownsTestAccount(owner, account)) return account;
  }
  function savedRecord(owner, id, entitled = false) {
    if (!owner || !sandbox()) return;
    const film = store.film(owner, id);
    if (film?.id !== id || film.programId || !film.bucket || !film.objectKey || !/^[A-Za-z0-9_-]{43}$/.test(film.revision) ||
        typeof film.title !== 'string' || !film.title.trim() || film.title.length > 160 || !validRights(film.rights)) return;
    const prices = filmPrices(film.prices);
    const seconds = previewSeconds(film.previewSeconds), hours = rentalHours(film.rentalHours);
    if (!prices || seconds === null || hours === null || !(film.duration > seconds)) return;
    const account = seller(owner);
    if (!account && !(entitled && store.priorOrderOwner(id) === owner)) return;
    // A null recipient is an existing-order lookup only. Use the claimed
    // seller recorded on that order, even while this filmmaker reconnects.
    const spec = Object.freeze({ id, title: film.title, info: film.info, thumbnail: film.thumbnail, owner, account: entitled ? null : account, scope: savedFilmScope(owner, id),
      revision: film.revision, authority, prices, duration: film.duration, previewSeconds: seconds, rentalHours: hours, screenerWatermark:film.screenerWatermark === true });
    return { spec, bucket: film.bucket, objectKey: film.objectKey, extension: film.extension || 'mp4' };
  }

  function record(id, { entitled = false } = {}) {
    if (!authority || !filmId.test(id)) return;
    const entry = savedRecord(publicationOwner(id, entitled), id, entitled);
    return entry && { ...entry, entitled };
  }
  function requireRecord(id, options) {
    const entry = record(id, options);
    if (!entry) throw unavailable();
    return entry;
  }

  function current(entry) {
    const next = entry.preparing ? savedRecord(entry.spec.owner, entry.spec.id) : requireRecord(entry.spec.id, entry);
    if (!next || next.spec.owner !== entry.spec.owner || next.spec.account !== entry.spec.account ||
        next.spec.revision !== entry.spec.revision || next.objectKey !== entry.objectKey ||
        next.bucket.accountId !== entry.bucket.accountId || next.bucket.jurisdiction !== entry.bucket.jurisdiction ||
        next.bucket.bucket !== entry.bucket.bucket) throw unavailable();
    return next;
  }

  // openFilm calls head() on each render, including when its input index is
  // cached. Use the saved source and the current credential for every new render.
  function privateSource(entry, validate = current) {
    let reader;
    function sourceFailure(error) {
      if (error instanceof PrivateOriginalUnavailable) {
        store.pauseProgramsForSource(entry.spec.owner, entry);
      }
      throw error;
    }
    return {
      async head() {
        const live = validate(entry);
        const credentials = store.credentials(live.spec.owner, live.bucket);
        const source = sourceFor({ ...credentials, ...live.bucket, objectKey: live.objectKey });
        let head;
        try { head = await source.head(); } catch (error) { sourceFailure(error); }
        validate(entry);
        if (revisionFor(head) !== live.spec.revision) sourceFailure(new PrivateOriginalUnavailable());
        reader = source;
        return head;
      },
      async read(head, start, end) {
        try { return await reader.read(head, start, end); } catch (error) { sourceFailure(error); }
      },
      async *stream(head, start, end, signal) {
        try {
          if (reader.stream) {
            yield* reader.stream(head, start, end, signal);
            return;
          }
          for (let offset = start; offset < end; offset += BLOCK_SIZE) {
            signal?.throwIfAborted();
            yield await reader.read(head, offset, Math.min(end, offset + BLOCK_SIZE));
          }
        } catch (error) { sourceFailure(error); }
      }
    };
  }

  async function originalFile(entry, validate, orderId) {
    const source = privateSource(entry, validate);
    const head = await source.head();
    // The caller rechecks this purchase order before beginning HTTP delivery.
    return {
      size: head.size, title: entry.spec.title, extension: entry.extension,
      contentType: videoContentType(entry.extension), revision: entry.spec.revision, orderId,
      async *stream(start = 0, end = head.size, signal) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > head.size) {
          throw new Error('Invalid download range.');
        }
        validate(entry);
        let bytes = 0;
        let recheck = 0;
        for await (const chunk of source.stream(head, start, end, signal)) {
          if (bytes >= recheck) {
            validate(entry);
            recheck = bytes + 4 * 1024 * 1024;
          }
          bytes += chunk.byteLength;
          if (bytes > end - start) throw unavailable();
          yield chunk;
        }
        if (bytes !== end - start) throw unavailable();
      }
    };
  }

  const programs = programCatalog({store,authority,sandbox,seller,privateSource,openMedia,originalFile,thumbnails});
  return Object.freeze({
    programPreview: programs.programPreview,
    openProgramPreview: programs.openProgramPreview,
    programFile: programs.programFile,
    get(id, options) { return isProgramId(id) ? programs.get(id, options) : record(id, options)?.spec; },
    isPublished(owner, id) {
      return isProgramId(id) ? Boolean(store.program(owner, id)?.published) : publicationOwner(id) === owner;
    },
    async publish(owner, id) {
      if (isProgramId(id)) return programs.publish(owner,id);
      const entry = savedRecord(owner, id);
      if (!entry) throw unavailable();
      await privateSource({ ...entry, preparing: true }).head();
      if (!store.setFilmPublication(owner, id, true)) throw unavailable();
    },
    recordView(id, kind, eventId, options) {
      if (isProgramId(id)) return programs.recordView(id,kind,eventId,options);
      const entry = record(id, { entitled: kind === 'paid' });
      if (!entry || (kind === 'preview' && !entry.spec.previewSeconds)) return false;
      return store.recordView(entry.spec.owner, id, kind, eventId);
    },
    list() {
      const films = [];
      for (const id of new Set([...publications().keys(), ...store.publishedFilmIds()])) {
        const entry = record(id);
        if (entry) films.push({ id, title: entry.spec.title });
      }
      for (const id of store.publishedProgramIds?.() || []) {
        const spec = programs.get(id);
        if (spec) films.push({id,title:spec.title});
      }
      return films;
    },
    async poster(id,options) {
      if (isProgramId(id)) return programs.poster(id,options);
      const entry = record(id);
      if (!entry?.spec.thumbnail) return;
      const bytes = await thumbnails.poster(entry.spec.owner, { ...entry.spec, bucket: entry.bucket, objectKey: entry.objectKey });
      if (record(id)?.spec.thumbnail === entry.spec.thumbnail) return bytes;
    },
    async verify(id, options) {
      if (isProgramId(id)) return programs.verify(id,options);
      try {
        const entry = requireRecord(id, options);
        await privateSource(entry).head();
        return current(entry).spec;
      } catch { throw unavailable(); }
    },
    async download(id, grant) {
      const entry = requireRecord(id, { entitled: true });
      const { orderId } = await authority.verifyDownloadGrant(grant, { film: entry.spec.scope, revision: entry.spec.revision });
      return originalFile(entry,current,orderId);
    },
    async open(id, options) {
      if (isProgramId(id)) return programs.open(id,options);
      let media;
      try {
        const entry = requireRecord(id, options);
        media = await openMedia(privateSource(entry), { previewSeconds: entry.spec.previewSeconds });
        current(entry);
        if (media.revision !== entry.spec.revision) throw unavailable();
        return { ...media, async preview(seconds,rendition) {
          const offered = requireRecord(id).spec.previewSeconds;
          if (!offered || (seconds !== undefined && offered !== seconds)) throw unavailable();
          const bytes = await media.preview(offered,rendition);
          if (requireRecord(id).spec.previewSeconds !== offered) throw unavailable();
          return bytes;
        } };
      } catch {
        media?.close();
        throw unavailable();
      }
    }
  });
}
