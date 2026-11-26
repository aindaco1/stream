import { filmPrices, maxPreviewSeconds, savedPreviewSeconds, rentalHours, usdInput } from './prices.js';
import { escapeHtml } from './film-embed.js';

export const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

export function formatDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return '';
  const seconds = Math.round(duration);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && `${hours} h`, minutes && `${minutes} min`, seconds % 60 && `${seconds % 60} sec`]
    .filter(Boolean).join(' ');
}

export function programOfferSummary({ prices, rentalHours }) {
  const offers = [];
  if (prices.rent != null) offers.push(`Rent $${usdInput(prices.rent)} for ${rentalHours} ${rentalHours === 1 ? 'hour' : 'hours'}`);
  if (prices.buy != null) offers.push(`Buy for $${usdInput(prices.buy)} with ZIP download`);
  return offers.join(' · ') || 'No rental or download offered';
}

export function priceFields(film, program = false) {
  const prices = filmPrices(film.prices) ?? { rent: null, buy: null };
  const maxPreview = maxPreviewSeconds(film.duration);
  return `<fieldset class="price-fields"><legend>Prices and playback</legend>
    <div class="field-stack">
      <p class="hint">Rental time starts at payment. ${program ? 'Buyers can download the entire lineup as a ZIP, including the opening and closing videos.' : 'Buyers can save the original film file.'} Leave a price blank to turn off that offer for new viewers.</p>
      <div class="price-grid">
        <label>Rental price (USD) <input type="number" name="rentPrice" min="0.50" max="999999.99" step="0.01" inputmode="decimal" value="${usdInput(prices.rent)}"></label>
        <label>Rental duration (hours) <input type="number" name="rentalHours" min="1" max="720" step="1" required value="${rentalHours(film.rentalHours)}"></label>
        <label>Download purchase (USD) <input type="number" name="buyPrice" min="0.50" max="999999.99" step="0.01" inputmode="decimal" value="${usdInput(prices.buy)}"></label>
        <label>Free preview (seconds) <input type="number" name="previewSeconds" min="0" max="${maxPreview}" step="1" required value="${savedPreviewSeconds(film.previewSeconds, film.duration)}"></label>
      </div>
      <p class="hint">Maximum <span data-preview-max>${maxPreview}</span> seconds. Leave at least one second of the video after the preview. Set 0 to show the offers immediately.</p>
      <div class="watermark-setting"><label>Rental screener watermark
        <select name="screenerWatermark" aria-describedby="watermark-${escapeHtml(film.id || 'draft')}">
          <option value="off"${film.screenerWatermark !== true ? ' selected' : ''}>Off</option>
          <option value="on"${film.screenerWatermark === true ? ' selected' : ''}>On</option>
        </select>
      </label>
      <p class="hint" id="watermark-${escapeHtml(film.id || 'draft')}">Show an order-specific code briefly each minute in the video.</p></div>
    </div>
  </fieldset>`;
}
