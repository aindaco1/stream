export function faqLink(current = false) {
  return `<a href="/faq"${current ? ' aria-current="page"' : ''}>FAQ</a>`;
}

export function siteFooter(home) {
  return `<footer class="site-footer"><div class="site-footer-inner">
    <a href="${home}" aria-label="Stream home"><img src="/dust-wave-square.webp" alt="" width="32" height="32"></a>
    <span>(ɔ) ${new Date().getUTCFullYear()} DUST WAVE</span>
  </div></footer>`;
}
