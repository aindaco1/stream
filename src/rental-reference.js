import { createHash } from 'node:crypto';

export function rentalReference(scope, orderId) {
  return createHash('sha256').update(JSON.stringify(['screener', scope, orderId])).digest('hex').slice(0, 8).toUpperCase();
}

export function screenerReference(offer, access) {
  if (offer.screenerWatermark && access?.access === 'rent' && access.orderId) return rentalReference(offer.scope, access.orderId);
}
