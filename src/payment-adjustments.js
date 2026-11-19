import { readBoundedJson } from '@dustwave/worker-core/response-body';

const closed = new Set(['won', 'prevented', 'warning_closed']);
export const adjustmentEvents = new Set(['charge.refunded', 'charge.refund.updated', 'refund.created', 'refund.updated', 'refund.failed',
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);

export function adjustmentReference(event) {
  const object = event.data?.object;
  const type = event.type.startsWith('charge.dispute.') ? 'dispute' : event.type === 'charge.refunded' ? 'charge' : 'refund';
  if (object?.object !== type || object.livemode === true ||
      (type === 'refund' && !/^re_[a-zA-Z0-9]+$/.test(object.id)) ||
      (type === 'dispute' && !/^du_[a-zA-Z0-9]+$/.test(object.id))) return;
  const chargeId = type === 'charge' ? object.id : object.charge;
  if (!/^ch_[a-zA-Z0-9]+$/.test(chargeId)) return;
  const intentId = object.payment_intent;
  if (intentId != null && !/^pi_[a-zA-Z0-9]+$/.test(intentId)) return;
  return { type, chargeId, intentId, id:object.id };
}

// These read-only resources aren't exposed by the pinned worker-core client.
export function adjustmentReader(key, account, fetchImpl) {
  async function get(path) {
    const response = await fetchImpl('https://api.stripe.com/v1/' + path, {method:'GET', redirect:'error',
      headers:{Authorization:'Bearer ' + key,'Stripe-Account':account,'Stripe-Version':'2026-10-28.endive'},
      signal:AbortSignal.timeout(15000)});
    if (!response.ok) { await response.body?.cancel(); throw Error('Payment adjustment unavailable.'); }
    return readBoundedJson(response, 2 * 1024 * 1024);
  }
  async function* list(resource,charge) {
    const query = new URLSearchParams({charge,limit:'100'});
    const seen = new Set();
    for (;;) {
      const page = await get(resource + '?' + query);
      if (page?.object !== 'list' || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw Error('Invalid payment adjustment list.');
      for (const row of page.data) {
        if (row.charge !== charge || row.livemode === true || typeof row.id !== 'string' || seen.has(row.id)) throw Error('Invalid payment adjustment.');
        seen.add(row.id);
        yield row;
      }
      if (!page.has_more) return;
      if (!page.data.length) throw Error('Incomplete payment adjustment list.');
      query.set('starting_after',page.data.at(-1).id);
    }
  }
  return {
    async chargeIntent(id) {
      if (!/^ch_[a-zA-Z0-9]+$/.test(id)) throw Error('Invalid charge.');
      const row = await get('charges/' + id);
      if (row?.object !== 'charge' || row.id !== id || row.livemode !== false) throw Error('Invalid charge.');
      return row.payment_intent;
    },
    async state(order,charge,hint) {
      let refundedAmount = 0;
      if (charge.amount_refunded || charge.refunded || order.refundedAmount || hint?.type === 'refund' || hint?.type === 'charge') {
        let found = false;
        let referenced = false;
        for await (const refund of list('refunds',charge.id)) {
          if (refund.object !== 'refund' || refund.currency !== charge.currency || (refund.payment_intent && refund.payment_intent !== charge.payment_intent) ||
              !Number.isSafeInteger(refund.amount) || refund.amount < 0) throw Error('Invalid refund.');
          found = true;
          if (refund.id === hint?.id) referenced = true;
          if (refund.status === 'succeeded') refundedAmount += refund.amount;
        }
        if (refundedAmount > charge.amount) throw Error('Invalid refund total.');
        // A fully refunded charge and an empty list is an inconsistent provider snapshot.
        if (((charge.refunded || charge.amount_refunded > 0 || hint?.type === 'charge') && !found) ||
            (hint?.type === 'refund' && !referenced)) throw Error('Incomplete refund information.');
      }
      let disputeStatus = null;
      if (charge.disputed || order.disputeStatus || hint?.type === 'dispute') {
        let referenced = false;
        for await (const dispute of list('disputes',charge.id)) {
          if (dispute.object !== 'dispute' || typeof dispute.status !== 'string' || !dispute.status ||
              (dispute.payment_intent && dispute.payment_intent !== charge.payment_intent)) throw Error('Invalid dispute.');
          if (dispute.id === hint?.id) referenced = true;
          if (dispute.status === 'lost' || disputeStatus === null || (closed.has(disputeStatus) && !closed.has(dispute.status))) {
            disputeStatus = dispute.status;
          }
        }
        if (!disputeStatus && (charge.disputed || hint?.type === 'dispute' || order.disputeStatus)) throw Error('Incomplete dispute information.');
        if (hint?.type === 'dispute' && !referenced) throw Error('Incomplete dispute information.');
      }
      const revocationReason = refundedAmount === order.amount ? 'refund' :
        disputeStatus && !closed.has(disputeStatus) ? 'dispute' : null;
      return { chargeId:charge.id, refundedAmount, disputeStatus, revocationReason };
    }
  };
}
