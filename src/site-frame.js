export const siteIcons = `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">`;

export function siteBrand(home) {
  return `<a class="brand" href="${home}" aria-label="Stream home"><img src="/favicon.svg" width="40" height="40" alt="">Stream</a>`;
}

export function faqLink(current = false, href = '/faq') {
  return `<a href="${href}"${current ? ' aria-current="page"' : ''}>FAQ</a>`;
}

export function siteFooter(home) {
  return `<footer class="site-footer"><div class="site-footer-inner">
    <a href="${home}" aria-label="Stream home"><img src="/dust-wave-square.webp" alt="" width="32" height="32"></a>
    <span>(ɔ) ${new Date().getUTCFullYear()} DUST WAVE</span>
    <a class="privacy-link" href="/privacy">Privacy policy</a>
    <label class="appearance" title="Appearance"><select aria-label="Appearance" data-appearance-select>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select></label>
  </div></footer>`;
}
