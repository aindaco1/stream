import { mountAccessibleTabs, mountResponsiveTabSelect } from './tabs.js';

const workspace = document.querySelector('.workspace-nav');
const links = workspace.querySelectorAll('a[href]');
const currentPage = workspace.querySelector('[aria-current="page"]').getAttribute('href');
const pages = mountResponsiveTabSelect(workspace, {
  tabList: workspace.querySelector('.tab-bar'),
  tabs: links,
  label: workspace.getAttribute('aria-label'),
  value: link => link.getAttribute('href'),
  activeValue: currentPage,
  activate: path => location.assign(path)
});
// A history traversal can restore a select's old form value from the page cache.
window.addEventListener('pageshow', () => { pages.select.value = currentPage; });

// Older setup links pointed to a film tab. Its contents now live on Dashboard.
if (location.pathname === '/setup' && location.hash === '#film') location.replace('/setup/dashboard#films');
const sections = document.querySelector('.workspace-sections');
if (sections) {
  const list = sections.querySelector('.subtabs');
  list.setAttribute('role', 'tablist');
  for (const link of list.querySelectorAll('[data-tab]')) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = link.id;
    tab.dataset.tab = link.dataset.tab;
    tab.textContent = link.textContent;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', tab.dataset.tab);
    link.replaceWith(tab);
    const panel = document.getElementById(tab.dataset.tab);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
  }

  let activeSection;
  let restoring = true;
  const tabs = mountAccessibleTabs(sections, {
    initialTab: sections.dataset.initial,
    responsiveSelect: { tabList: list, label: list.getAttribute('aria-label') },
    storage: null,
    onSelect(name) {
      if (!restoring && activeSection !== name) history.pushState(null, '', currentPage + '#' + name);
      activeSection = name;
    }
  });
  // Give form responses a reloadable URL for the section containing their feedback.
  if (location.pathname !== currentPage) history.replaceState(null, '', currentPage + '#' + sections.dataset.initial);
  function restore() {
    const target = document.getElementById(location.hash.slice(1));
    const panel = target?.closest('.workspace-panel');
    if (panel || !location.hash) {
      restoring = true;
      const name = tabs.select(panel?.id || sections.dataset.initial);
      tabs.responsiveSelect.select.value = name;
      if (panel && target !== panel) target.scrollIntoView();
    }
    restoring = false;
  }
  restore();
  window.addEventListener('hashchange', restore);
  window.addEventListener('popstate', restore);
  window.addEventListener('pageshow', restore);
}
