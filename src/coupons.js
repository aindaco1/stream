import { randomUUID } from 'node:crypto';
import { discountCents, normalizeCouponCode, validCouponCode } from '@dustwave/coupon-core';
import { escapeHtml } from './film-embed.js';
import { hidden } from './offer-fields.js';

const kinds = ['both','rent','buy'];
function invalid(message) { throw Object.assign(Error(message),{code:'coupon_invalid',statusCode:422}); }
const sold = "(o.paidAt IS NOT NULL OR o.status='pending')";
const titles = `SELECT id,metadata->>'$.title' AS title FROM films WHERE owner=? AND id NOT IN (SELECT filmId FROM program_videos)
  UNION ALL SELECT id,metadata->>'$.title' FROM programs WHERE owner=? ORDER BY title`;

export function couponStore(db,transaction) {
  const sql = q => db.prepare(q);
  db.exec(`CREATE TABLE IF NOT EXISTS film_coupons (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, code TEXT NOT NULL, type TEXT NOT NULL, value INTEGER NOT NULL,
    titleId TEXT NOT NULL, kind TEXT NOT NULL, ends TEXT NOT NULL, maxUses INTEGER, version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(owner,code))`);
  return {
    couponSettings(owner) {
      const coupons = sql(`SELECT c.*,(SELECT count(*) FROM viewer_test_orders o WHERE o.couponId=c.id AND ${sold}) AS uses
        FROM film_coupons c WHERE c.owner=:owner ORDER BY c.code`).all({owner});
      return {coupons,titles:sql(titles).all(owner,owner)};
    },
    changeCoupon(owner,data) {
      return transaction(() => {
        const {id,action} = data;
        const current = id && sql('SELECT * FROM film_coupons WHERE owner=? AND id=?').get(owner,id);
        if (id && (!current || current.version !== Number(data.version))) invalid('This coupon changed. Reload Settings.');
        if (action === 'delete' && current) return sql('DELETE FROM film_coupons WHERE owner=? AND id=?').run(owner,id).changes;
        const code = normalizeCouponCode(data.code);
        if (action !== 'save' || !validCouponCode(code)) invalid('Use 2–40 letters, numbers, hyphens or underscores for the coupon code.');
        const type = data.type;
        if (!['amount','percent'].includes(type) || !/^\d{1,6}(?:\.\d{1,2})?$/.test(data.value)) invalid('Enter a positive discount with up to two decimal places.');
        const value = Math.round(Number(data.value)*100);
        if (!value || (type==='percent' && value>10000)) invalid('Enter a positive discount of at most 100% or a fixed dollar amount.');
        if (!kinds.includes(data.kind) || (data.titleId && !sql(titles).all(owner,owner).some(t=>t.id===data.titleId))) invalid('Choose an available title and offer.');
        const ends = data.ends || '';
        if (ends && (!/^\d{4}-\d\d-\d\d$/.test(ends) || !Number.isFinite(Date.parse(ends)) || new Date(ends).toISOString().slice(0,10)!==ends)) invalid('Choose a valid expiry date.');
        const max = data.maxUses ? Number(data.maxUses) : null;
        if (max !== null && (!Number.isSafeInteger(max) || max<1 || max>1000000)) invalid('Enter a use limit between 1 and 1,000,000.');
        if (sql('SELECT 1 FROM film_coupons WHERE owner=? AND code=? AND id!=?').get(owner,code,id || '')) invalid('This filmmaker already has a coupon with that code.');
        const fields = [code,type,value,data.titleId || '',data.kind,ends,max];
        if (current) sql('UPDATE film_coupons SET code=?,type=?,value=?,titleId=?,kind=?,ends=?,maxUses=?,version=version+1 WHERE owner=? AND id=?').run(...fields,owner,id);
        else sql('INSERT INTO film_coupons(code,type,value,titleId,kind,ends,maxUses,owner,id) VALUES(?,?,?,?,?,?,?,?,?)').run(...fields,owner,randomUUID());
      });
    },
    couponForOrder(owner,titleId,kind,subtotal,input) {
      const code = normalizeCouponCode(input);
      const c = sql('SELECT * FROM film_coupons WHERE owner=? AND code=?').get(owner,code);
      if (!c || (c.titleId && c.titleId!==titleId) || (c.kind!=='both' && c.kind!==kind) ||
          (c.ends && Date.now()>=Date.parse(c.ends)+86400000)) invalid('That coupon is unavailable for this offer.');
      if (c.maxUses !== null) {
        // An unbound attempt can no longer create or expose a Session after 23 hours.
        sql("UPDATE viewer_test_orders SET status='expired',ledgerVersion=ledgerVersion+1 WHERE couponId=? AND status='pending' AND sessionId IS NULL AND createdAt<=?")
          .run(c.id,Date.now()-23*3600_000);
        if (sql(`SELECT count(*) AS n FROM viewer_test_orders o WHERE o.couponId=:id AND ${sold}`)
          .get({id:c.id}).n >= c.maxUses) invalid('That coupon has reached its use limit.');
      }
      const amount = subtotal-discountCents(subtotal,c.type,c.value);
      if (amount>0 && amount<50) invalid('That coupon leaves less than the minimum $0.50 charge.');
      return {id:c.id,code,amount};
    }
  };
}

export function couponPanel(csrf,{coupons=[],titles=[]}={}) {
  const h=escapeHtml;
  const option=(value,label,current)=>`<option value="${h(value)}"${current===value?' selected':''}>${h(label)}</option>`;
  const form=(c={})=>`<form method="post" action="/setup/coupons" class="film-form">
    ${hidden('csrf',csrf)}${hidden('id',c.id || '')}${hidden('version',c.version ?? '')}
    <label>Code<input name="code" maxlength="40" required value="${h(c.code || '')}" placeholder="FESTIVAL"></label>
    <label>Discount type<select name="type">${option('percent','Percent off',c.type)}${option('amount','US dollars off',c.type)}</select></label>
    <label>Discount value<input name="value" type="number" min="0.01" step="0.01" required value="${c.value ? c.value/100 : ''}"></label>
    <label>Title<select name="titleId">${option('','All films and programs',c.titleId)}${c.titleId && !titles.some(t=>t.id===c.titleId) ? option(c.titleId,'Unavailable title',c.titleId) : ''}${titles.map(t=>option(t.id,t.title,c.titleId)).join('')}</select></label>
    <label>Offer<select name="kind">${kinds.map((k,i)=>option(k,['Rentals and purchases','Rentals only','Purchases only'][i],c.kind)).join('')}</select></label>
    <label>Valid through (UTC, optional)<input type="date" name="ends" value="${h(c.ends || '')}"></label>
    <label>Maximum uses (optional)<input type="number" min="1" max="1000000" name="maxUses" value="${c.maxUses ?? ''}"></label>
    <div class="film-actions"><button name="action" value="save">${c.id?'Save changes':'Create coupon'}</button>
    ${c.id?'<button class="secondary" name="action" value="delete" formnovalidate>Delete coupon</button>':''}</div></form>`;
  return `<section class="film-card"><h2>Coupons</h2><p>Use one code per order. Discounts apply before tips and tax. An unfinished checkout reserves one use for up to 24 hours.</p>
    ${coupons.map(c=>'<details><summary>'+h(c.code)+' · '+c.uses+' used or reserved</summary>'+form(c)+'</details>').join('')}
    <h3>New coupon</h3>${form()}</section>`;
}
