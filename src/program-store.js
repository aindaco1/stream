import { createHash, randomUUID } from 'node:crypto';
import { filmPrices, previewSeconds, rentalHours } from './prices.js';

export const isProgramId = id => typeof id === 'string' && /^p-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id);
const filmId = /^f-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

function invalid(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

export function validRights(rights) {
  return (
    typeof rights?.version === 'string' &&
    Boolean(rights.version.trim()) &&
    typeof rights.statement === 'string' &&
    Boolean(rights.statement.trim()) &&
    Number.isFinite(Date.parse(rights.acceptedAt)) &&
    Date.parse(rights.acceptedAt) <= Date.now()
  );
}

export function programStore(db, transaction, filmFor) {
  db.exec(`CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, metadata TEXT NOT NULL, bucket_id TEXT,
      version INTEGER NOT NULL DEFAULT 1, revision TEXT, published INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS programs_owner ON programs(owner);
    CREATE TABLE IF NOT EXISTS program_versions (
      programId TEXT NOT NULL, revision TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(programId,revision)
    );`);
  const query = q => db.prepare(q);
  function row(owner, id) {
    return query(`SELECT p.*,b.config FROM programs p LEFT JOIN buckets b ON b.id=p.bucket_id AND b.owner=p.owner
      WHERE p.owner=? AND p.id=?`).get(owner, id);
  }
  function program(owner, id) {
    const p = row(owner, id);
    return (
      p && {
        ...JSON.parse(p.metadata),
        id: p.id,
        owner,
        version: p.version,
        revision: p.revision,
        published: Boolean(p.published),
        bucket: p.config && JSON.parse(p.config)
      }
    );
  }
  function programVersion(id, revision) {
    const saved = query('SELECT metadata FROM program_versions WHERE programId=? AND revision=?').get(id, revision);
    return saved && JSON.parse(saved.metadata);
  }
  function unpublish(owner, id, unavailableTitle = null) {
    const changed = query(
      `UPDATE programs SET published=0,version=version+1,
        metadata=CASE WHEN ? IS NULL THEN metadata ELSE json_set(metadata,'$.unavailableTitle',?) END
        WHERE owner=? AND id=? AND published=1`
    ).run(unavailableTitle, unavailableTitle, owner, id).changes;
    if (changed)
      query(
        "UPDATE viewer_test_orders SET withdrawalState='requested' WHERE owner=? AND filmId=? AND status='pending' AND withdrawalState IS NULL"
      ).run(owner, id);
    return Boolean(changed);
  }
  return {
    program,
    programVersion,
    programFilmDetails(owner, ids) {
      const rows =
        query(`SELECT id, json_extract(metadata,'$.info') AS info, json_extract(metadata,'$.thumbnail') AS thumbnail
        FROM films WHERE owner=? AND id IN (SELECT value FROM json_each(?))`).all(owner, JSON.stringify(ids));
      return new Map(
        rows.map(row => [
          row.id,
          { info: row.info ? JSON.parse(row.info) : undefined, thumbnail: row.thumbnail || undefined }
        ])
      );
    },
    programOwner(id) {
      return query('SELECT owner FROM programs WHERE id=?').get(id)?.owner;
    },
    publishedProgramIds() {
      return query('SELECT id FROM programs WHERE published=1 ORDER BY rowid')
        .all()
        .map(p => p.id);
    },
    createProgram(owner) {
      const id = 'p-' + randomUUID();
      const data = {
        title: '',
        members: [],
        previewFilmId: null,
        previewSeconds: 10,
        prices: { rent: 99, buy: null },
        rentalHours: 48,
        rights: null
      };
      const inserted = query(
        'INSERT INTO programs(id, owner, bucket_id, metadata) SELECT ?,id,bucket_id,? FROM makers WHERE id=?'
      ).run(id, JSON.stringify(data), owner).changes;
      if (!inserted) throw invalid('Filmmaker workspace unavailable.', 404);
      return program(owner, id);
    },
    saveProgram(owner, id, data, expectedVersion) {
      return transaction(() => {
        const current = program(owner, id);
        if (!current) throw invalid('Program unavailable.', 404);
        if (current.version !== expectedVersion) throw invalid('This program changed. Reload it before saving.', 409);
        if (
          typeof data?.title !== 'string' ||
          data.title.trim().length > 160 ||
          /[\u0000-\u001f\u007f]/u.test(data.title) ||
          !Array.isArray(data.members) ||
          data.members.length > 128
        )
          throw invalid('Check the program title and lineup.');
        const members = data.members.map(m => ({ filmId: m?.filmId, role: m?.role }));
        if (new Set(members.map(m => m.filmId)).size !== members.length) throw invalid('Choose each title once.');
        for (const [i, m] of members.entries()) {
          if (!filmId.test(m.filmId) || !filmFor(owner, m.filmId))
            throw invalid('Choose a film from your own library.');
          if (!(
            m.role === 'film' ||
            (m.role === 'opening' && i === 0) ||
            (m.role === 'closing' && i === members.length - 1)
          ))
            throw invalid('Check the opening and closing positions.');
        }
        const previewFilmId = data.previewFilmId || null;
        if (previewFilmId && !members.some(m => m.filmId === previewFilmId))
          throw invalid('Choose the preview from the lineup.');
        const prices = filmPrices(data.prices),
          hours = rentalHours(data.rentalHours),
          seconds = previewSeconds(data.previewSeconds);
        if (!prices || hours === null || seconds === null)
          throw invalid('Check the program prices, rental duration, and preview length.');
        if (data.rights && !validRights(data.rights)) throw invalid('Confirm your program distribution rights.');
        const updated = {
          title: data.title.trim(),
          members,
          previewFilmId,
          previewSeconds: seconds,
          prices,
          rentalHours: hours,
          rights: data.rights || null
        };
        if (current.thumbnail) updated.thumbnail = current.thumbnail;
        if (current.unavailableTitle) updated.unavailableTitle = current.unavailableTitle;
        query(`UPDATE programs SET metadata=?, bucket_id=COALESCE(bucket_id,(SELECT bucket_id FROM makers WHERE id=?)),
          version=version+1 WHERE id=? AND owner=?`).run(JSON.stringify(updated), owner, id, owner);
        return program(owner, id);
      });
    },
    commitProgramPublication(owner, id, version, snapshot) {
      return transaction(() => {
        const p = program(owner, id);
        if (p?.version !== version) throw invalid('This program changed. Reload it before publishing.', 409);
        const metadata = JSON.stringify(snapshot);
        const revision = createHash('sha256').update(metadata).digest('base64url');
        query('INSERT OR IGNORE INTO program_versions VALUES(?,?,?)').run(id, revision, metadata);
        query("UPDATE programs SET revision=?, published=1,version=version+1,metadata=json_remove(metadata,'$.unavailableTitle') WHERE id=? AND owner=?").run(
          revision,
          id,
          owner
        );
        return revision;
      });
    },
    unpublishProgram(owner, id) {
      return transaction(() => unpublish(owner, id));
    },
    pauseProgramsForSource(owner, {bucket, objectKey, spec}) {
      return transaction(() => {
        // Inspect only the selling edition. A read of a retired cut cannot close a replacement offer.
        const affected = query(`SELECT p.id, m.value ->> '$.title' AS title FROM programs p
          JOIN program_versions v ON v.programId=p.id AND v.revision=p.revision, json_each(v.metadata,'$.lineup') m
          WHERE p.owner=? AND p.published=1 AND m.value ->> '$.revision'=? AND m.value ->> '$.source.objectKey'=?
          AND m.value ->> '$.source.bucket.accountId'=? AND m.value ->> '$.source.bucket.bucket'=?
          AND coalesce(m.value ->> '$.source.bucket.jurisdiction','default')=?`)
          .all(owner, spec.revision, objectKey, bucket.accountId, bucket.bucket, bucket.jurisdiction || 'default');
        for (const {id,title} of affected) unpublish(owner, id, title);
      });
    },
    // The caller holds the same write transaction used to withdraw standalone sales.
    withdrawProgramsContaining(owner, filmId) {
      const programs =
        query(`SELECT p.id FROM programs p JOIN program_versions v ON v.programId=p.id AND v.revision=p.revision
        WHERE p.owner=? AND p.published=1 AND EXISTS (SELECT 1 FROM json_each(v.metadata,'$.lineup') m WHERE json_extract(m.value,'$.id')=?)`).all(
          owner,
          filmId
        );
      for (const p of programs) unpublish(owner, p.id);
    },
    previousProgramRevision(id) {
      return query(
        'SELECT revision FROM viewer_test_orders WHERE filmId=? AND sessionId IS NOT NULL ORDER BY createdAt DESC LIMIT 1'
      ).get(id)?.revision;
    },
    programOrderExists(id, revision) {
      return Boolean(
        query('SELECT 1 FROM viewer_test_orders WHERE filmId=? AND revision=? LIMIT 1').get(id, revision)
      );
    },
    setProgramPosition(orderId, memberId, seconds) {
      return (
        query(`UPDATE viewer_test_orders SET positionMember=?, position=? WHERE orderId=? AND status='paid'
        AND (kind='buy' OR paidAt+rentalHours*3600>unixepoch())
        AND EXISTS(SELECT 1 FROM program_versions v,json_each(v.metadata,'$.lineup') m WHERE v.programId=viewer_test_orders.filmId
        AND v.revision=viewer_test_orders.revision AND json_extract(m.value,'$.id')=? AND ? BETWEEN 0 AND json_extract(m.value,'$.duration'))`).run(
          memberId,
          seconds,
          orderId,
          memberId,
          seconds
        ).changes === 1
      );
    }
  };
}
