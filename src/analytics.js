// U.S. standard domestic card estimate in cents, rounded per successful charge.
function estimateStripeFee(chargedCents) {
  return Math.round(chargedCents * 29 / 1000) + 30;
}

const viewing = ['previews','plays','timedPlays','watchSeconds'];
const metrics = [...viewing, 'rentals', 'purchases', 'revenue', 'netRevenue', 'estimatedFees', 'reportedFees',
  'filmTaxFees', 'tipTaxFees', 'pendingTaxFees', 'platformTips', 'taxCollected', 'estimatedOrders', 'transfersToReview'];

export function sumFilmStats(films) {
  return Object.fromEntries(metrics.map(key => [key, films.reduce((sum, film) => sum + film.stats[key], 0)]));
}

// Start from the selected films. A filmmaker dashboard and a single directory
// page should only read the settled ledger entries for the films being shown.
function filmStats(filter = '', includeLineup = false) {
  const estimated = 'stream_fee_estimate(COALESCE(o.chargedTotalCents,o.amount + o.tipAmount))';
  return `SELECT f.owner, f.id, json_extract(f.metadata, '$.title') AS title,
    ${viewing.map(key => `${includeLineup ? `COALESCE(pc.${key},0) + ` : ''}COALESCE(c.${key},0) + COALESCE((SELECT SUM(ec.${key}) FROM program_videos v
      JOIN film_counts ec ON ec.filmId=v.filmId WHERE v.programId=f.id),0) AS ${key}`).join(', ')},
    COUNT(*) FILTER (WHERE o.kind='rent') AS rentals, COUNT(*) FILTER (WHERE o.kind='buy') AS purchases,
    COALESCE(SUM(o.amount),0) AS revenue, COALESCE(SUM(o.tipAmount - COALESCE(o.tipTaxCents,0) - (COALESCE(o.taxBasicFeeCents,0) - o.filmTaxFeeCents)),0) AS platformTips,
    COALESCE(SUM(o.filmTaxFeeCents),0) AS filmTaxFees,
    COALESCE(SUM(o.taxBasicFeeCents - o.filmTaxFeeCents),0) AS tipTaxFees,
    COUNT(*) FILTER (WHERE o.paidAt IS NOT NULL AND o.taxBasicFeeCents IS NULL) AS pendingTaxFees,
    COALESCE(SUM(o.taxCents),0) AS taxCollected, COALESCE(SUM(o.cardProcessingCents),0) AS reportedFees,
    COALESCE(SUM(${estimated}) FILTER (WHERE o.intentId IS NOT NULL),0) AS estimatedFees,
    COUNT(*) FILTER (WHERE o.intentId IS NOT NULL AND o.stripeFeeCents IS NULL) AS estimatedOrders,
    COUNT(*) FILTER (WHERE o.taxPolicy='marketplace-v1' AND COALESCE(o.transferId,'')!='no_proceeds' AND
      (o.refundedAmount>0 OR o.revocationReason IS NOT NULL OR o.disputeStatus NOT IN ('won','prevented','warning_closed'))) AS transfersToReview,
    COALESCE(SUM(o.amount - MIN(o.amount,o.refundedAmount) - COALESCE(o.cardProcessingCents, ${estimated}) - o.filmTaxFeeCents),0) AS netRevenue
    FROM (SELECT id,owner,metadata FROM films WHERE id NOT IN (SELECT filmId FROM program_videos) UNION ALL SELECT id,owner,metadata FROM programs) f LEFT JOIN film_counts c ON c.filmId=f.id
    ${includeLineup ? 'LEFT JOIN program_lineup_counts pc ON pc.filmId=f.id' : ''}
    LEFT JOIN viewer_test_orders o ON o.filmId=f.id AND o.owner=f.owner AND o.paidAt IS NOT NULL AND o.intentId IS NOT NULL
    ${filter} GROUP BY f.id`;
}

export function analyticsReports(db) {
  db.function('stream_fee_estimate', { deterministic: true }, estimateStripeFee);
  db.exec(`CREATE INDEX IF NOT EXISTS film_owner ON films(owner);
    CREATE INDEX IF NOT EXISTS sales_by_film ON viewer_test_orders(filmId,owner) WHERE paidAt IS NOT NULL AND intentId IS NOT NULL;`);
  const totals = metrics.map(key => 'COALESCE(SUM(a.' + key + '),0) AS ' + key).join(', ');
  const byOwner = filmStats('WHERE f.owner=?');
  const pageSize = 25;
  function report(owner, page) {
    if (owner !== null && !db.prepare('SELECT 1 FROM makers WHERE id=?').get(owner)) return null;
    const global = owner === null;
    const args = global ? [] : [owner];
    const total = db.prepare(`SELECT COUNT(*) FILTER (WHERE a.id NOT LIKE 'p-%') AS films, COUNT(*) FILTER (WHERE a.id LIKE 'p-%') AS programs, ${totals} FROM (${global ? filmStats() : byOwner}) a`).get(...args);
    const makers = db.prepare('SELECT COUNT(*) AS n FROM makers').get().n;
    const pages = Math.max(1, Math.ceil((global ? makers : total.films + total.programs) / pageSize));
    page = Number.isSafeInteger(page) ? Math.max(1, Math.min(pages, page)) : 1;
    const offset = (page - 1) * pageSize;
    const rows = global
      ? db.prepare(`WITH roster AS (SELECT id FROM makers ORDER BY id LIMIT ? OFFSET ?),
          stats AS (${filmStats('WHERE f.owner IN (SELECT id FROM roster)')})
          SELECT m.id AS name, COUNT(a.id) FILTER (WHERE a.id NOT LIKE 'p-%') AS films, COUNT(a.id) FILTER (WHERE a.id LIKE 'p-%') AS programs, ${totals}
          FROM roster m LEFT JOIN stats a ON a.owner=m.id GROUP BY m.id ORDER BY m.id`).all(pageSize, offset)
      : db.prepare(`SELECT * FROM (${filmStats('WHERE f.owner=?',true)}) ORDER BY title COLLATE NOCASE,id LIMIT ? OFFSET ?`).all(owner, pageSize, offset);
    return { owner, total, makers, rows, page, pages };
  }
  return {
    programStats(owner) {
      return db.prepare(`SELECT a.*, ${viewing.map(k => `COALESCE(c.${k},0) AS lineup_${k}`).join(', ')}
        FROM (${byOwner}) a JOIN programs p ON p.id=a.id LEFT JOIN program_lineup_counts c ON c.filmId=p.id ORDER BY p.rowid DESC`).all(owner)
        .map(row => ({
          id:row.id, stats:Object.fromEntries(metrics.map(k => [k,row[k]])),
          lineupViews:Object.fromEntries(viewing.map(k => [k,row[k] + row['lineup_' + k]]))
        }));
    },
    dashboardFilms(owner) {
      const rows = db.prepare(`SELECT f.metadata, json_extract(b.config,'$.uploads') AS uploads,
        ${metrics.map(key => 'a.' + key).join(', ')}
        FROM (${byOwner}) a JOIN films f ON a.id=f.id
        JOIN buckets b ON b.id=f.bucket_id AND b.owner=f.owner ORDER BY f.rowid DESC`).all(owner);
      return rows.map(({ metadata, uploads, ...stats }) => {
        const { id, title, prices, previewSeconds, rentalHours, screenerWatermark, duration, info, thumbnail, unsupportedSubtitles } = JSON.parse(metadata);
        return { id, title, prices, previewSeconds, rentalHours, screenerWatermark, duration, info, thumbnail, unsupportedSubtitles, uploads: Boolean(uploads), stats };
      });
    },
    platformReport(owner, page = 1) {
      db.exec('BEGIN');
      try {
        return report(owner, page);
      } finally {
        db.exec('ROLLBACK'); // End the read snapshot shared by totals and rows.
      }
    }
  };
}
