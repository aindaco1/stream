import { createHash } from 'node:crypto';
import { savedFilmScope } from './rental.js';
import { PrivateOriginalUnavailable } from './source.js';
import { validRights } from './program-store.js';

const unavailable = () => new Error('Program unavailable.');
const invalid = message => Object.assign(new Error(message), { status: 422 });

// A version is a frozen program offer and ordered set of source revisions.
// Bucket coordinates stay inside its manifest; only project() can serialize a lineup.
export function programCatalog({
  store,
  authority,
  seller,
  sandbox,
  privateSource,
  openMedia,
  originalFile,
  thumbnails
}) {
  function draft(owner, id, publishing = false) {
    const p = store.program(owner, id);
    if (!p) throw unavailable();
    if (!p.title || p.members.filter(m => m.role === 'film').length < 2)
      throw invalid('Give the program a title and choose at least two films.');
    if (publishing && (!validRights(p.rights) || (!p.prices.rent && !p.prices.buy)))
      throw invalid('Confirm your program rights and enable a rental or purchase price.');
    const lineup = p.members.map(({ filmId, role, title }) => {
      const f = store.film(owner, filmId);
      if (!f || !validRights(f.rights) || !f.objectKey || !f.bucket || !f.revision || !(f.duration > 0))
        throw unavailable();
      const { accountId, jurisdiction, bucket } = f.bucket;
      return {
        id: filmId,
        role,
        title: title || f.title,
        duration: f.duration,
        revision: f.revision,
        extension: f.extension || 'mp4',
        source: { bucket: { accountId, jurisdiction, bucket }, objectKey: f.objectKey }
      };
    });
    const firstFilm = lineup.find(m => m.role === 'film');
    const previewId = p.previewFilmId || firstFilm.id;
    const preview = lineup.find(m => m.id === previewId);
    if (!preview || p.previewSeconds >= preview.duration)
      throw invalid('Choose a preview shorter than its selected video.');
    return {
      owner,
      id,
      version: p.version,
      snapshot: {
        title: p.title,
        prices: p.prices,
        rentalHours: p.rentalHours,
        ...(p.screenerWatermark === true && {screenerWatermark:true}),
        previewId,
        previewSeconds: p.previewSeconds,
        duration: lineup.reduce((sum, m) => sum + m.duration, 0),
        lineup
      }
    };
  }

  function version(id, { entitled = false, revision } = {}) {
    const owner = store.programOwner(id);
    if (!owner || !sandbox()) return;
    const p = store.program(owner, id);
    const account = seller(owner);
    if (revision === undefined) {
      // A withdrawn program might only have orders on an earlier edition.
      // Keep its bare recovery URL usable while hiding the lineup until the order is verified.
      revision = entitled && (!p.published || !account) ? store.previousProgramRevision(id) : p.revision;
    }
    if (!revision || typeof revision !== 'string') return;
    const available = p.published && p.revision === revision;
    const historical = entitled && store.programOrderExists(id, revision);
    if ((!available || !account) && !historical) return;
    const snapshot = store.programVersion(id, revision);
    if (!snapshot) return;
    return { id, owner, p, account: entitled ? null : account, revision, snapshot };
  }
  function project(edition) {
    const { id, owner, revision, account, snapshot } = edition;
    const { title, prices, rentalHours, previewId, previewSeconds, duration } = snapshot;
    const details = store.programFilmDetails(
      owner,
      snapshot.lineup.map(member => member.id)
    );
    const lineup = snapshot.lineup.map(({ id, role, title, duration, extension, size }) => ({
      id,
      role,
      title,
      duration,
      extension,
      size,
      ...details.get(id)
    }));
    const thumbnail = edition.p?.thumbnail || lineup.find(member => member.role === 'film')?.thumbnail;
    return {
      id,
      title,
      owner,
      type: 'program',
      revision,
      account,
      authority,
      scope: savedFilmScope(owner, id),
      previewId,
      previewSeconds,
      duration,
      prices,
      rentalHours,
      screenerWatermark: snapshot.screenerWatermark === true,
      thumbnail,
      lineup
    };
  }
  function privateDraft(owner, id) {
    const v = draft(owner, id);
    return {
      ...v,
      p: store.program(owner, id),
      revision: createHash('sha256')
        .update(id + ':' + v.version)
        .digest('base64url'),
      account: null
    };
  }
  function memberEntry(v, memberId) {
    const m = v.snapshot.lineup.find(member => member.id === memberId);
    if (!m) throw unavailable();
    return {
      ...m.source,
      extension: m.extension,
      spec: { owner: v.owner, id: m.id, title: m.title, revision: m.revision }
    };
  }
  function check(v, options) {
    return entry => {
      if (v.version !== undefined) {
        if (store.program(v.owner, v.id)?.version !== v.version) throw unavailable();
      } else if (!version(v.id, { ...options, revision: v.revision })) throw unavailable();
      return entry;
    };
  }
  async function open(v, options = {}) {
    if (!v) throw unavailable();
    const memberId = options.memberId ?? v.snapshot.previewId;
    if (!options.entitled && memberId !== v.snapshot.previewId) throw unavailable();
    const entry = memberEntry(v, memberId),
      validate = check(v, options);
    const seconds = v.snapshot.previewSeconds;
    let media;
    try {
      media = await openMedia(privateSource(entry, validate), {
        previewSeconds: memberId === v.snapshot.previewId ? seconds : 0
      });
      validate(entry);
      if (media.revision !== entry.spec.revision) throw unavailable();
      return {
        ...media,
        async preview(requested = seconds, rendition) {
          validate(entry);
          if (!seconds || requested !== seconds || memberId !== v.snapshot.previewId) throw unavailable();
          const result = await media.preview(seconds, rendition);
          validate(entry);
          return result;
        }
      };
    } catch (e) {
      media?.close();
      throw e;
    }
  }
  return {
    get(id, options) {
      const v = version(id, options);
      return authority && v ? project(v) : undefined;
    },
    async publish(owner, id) {
      if (!sandbox() || !seller(owner)) throw unavailable();
      const v = draft(owner, id, true);
      const validate = check(v);
      for (const m of v.snapshot.lineup) {
        try {
          const head = await privateSource(memberEntry(v, m.id), validate).head();
          m.size = head.size;
        } catch (error) {
          if (error instanceof PrivateOriginalUnavailable)
            throw invalid(`The original for “${m.title}” changed or is missing. Restore the original or replace this title in the lineup before publishing.`);
          throw error;
        }
      }
      if (!seller(owner)) throw unavailable();
      return store.commitProgramPublication(owner, id, v.version, v.snapshot);
    },
    async verify(id) {
      const v = version(id);
      if (!v || !authority) throw unavailable();
      const validate = check(v);
      for (const m of v.snapshot.lineup) await privateSource(memberEntry(v, m.id), validate).head();
      validate();
      if (seller(v.owner) !== v.account) throw unavailable();
      return project(v);
    },
    open(id, options) {
      return open(version(id, options), options);
    },
    programPreview(owner, id) {
      return project(privateDraft(owner, id));
    },
    openProgramPreview(owner, id) {
      return open(privateDraft(owner, id));
    },
    async programFile(id, revision, memberId) {
      const options = { entitled: true, revision },
        v = version(id, options);
      if (!v) throw unavailable();
      return originalFile(memberEntry(v, memberId), check(v, options));
    },
    async poster(id, options = {}) {
      const v = version(id, options);
      if (!v) return;
      const main = v.snapshot.lineup.find(m => m.role === 'film');
      const memberId = options.memberId ?? (v.p.thumbnail ? null : main.id);
      if (memberId && !v.snapshot.lineup.some(m => m.id === memberId)) return;
      const f = memberId ? store.film(v.owner, memberId) : v.p;
      if (!f?.thumbnail || !f.bucket) return;
      const image = await thumbnails.poster(v.owner, f);
      const current = version(id, { ...options, revision: v.revision });
      if (!current || (!options.memberId && current.p.thumbnail !== v.p.thumbnail)) return;
      if (!memberId || store.film(v.owner, memberId)?.thumbnail === f.thumbnail) return image;
    },
    recordView(id, kind, eventId, options = {}) {
      const v = version(id, { entitled: kind === 'paid', revision: options.revision });
      if (!v || (kind === 'preview' && !v.snapshot.previewSeconds)) return false;
      const memberId = options.memberId ?? v.snapshot.previewId;
      if (
        (kind === 'preview' && memberId !== v.snapshot.previewId) ||
        !v.snapshot.lineup.some(m => m.id === memberId)
      )
        return false;
      return store.recordView(v.owner, memberId, kind, eventId);
    }
  };
}
