import { checkoutAvailability } from './filmmaker-help.js';
import { stripeSetupStateForMode } from './setup-stripe.js';
import { renderDashboard, renderSettingsPage } from './setup-view.js';

export const workspaceCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self' https://*.stripe.com; frame-ancestors 'none'; base-uri 'none'";
export const dashboardCsp = previewOrigin =>
  workspaceCsp.replace("img-src 'self'", "img-src 'self' blob:") + "; connect-src 'self'; frame-src " + previewOrigin;

export function filmmakerSettings({ store, session, provider, salesTerritory, path, searchParams, feedback }) {
  const coupons = searchParams.get('section') === 'coupons' || feedback?.initialSection === 'coupons';
  const { r2, stripe, draft, couponSettings } = store.filmmakerSettings(session.owner,coupons);
  const mode = store.paymentMode;
  const state = stripeSetupStateForMode(stripe, mode);
  return renderSettingsPage({
    couponSettings, filmmaker: { name: session.email || session.owner }, csrf: session.csrf,
    initialSection: coupons ? 'coupons' : path.startsWith('/setup/stripe/') ? 'payments' : 'storage',
    stripe: {
      configured: provider.configured, mode, existingAvailable: provider.existingOAuth,
      availability: mode === 'live' ? checkoutAvailability(salesTerritory) : '',
      hasAccount: Boolean(state.accountId), creating: Boolean(state.createRequest),
      canReset: Boolean(state.accountId || state.flow || state.createRequest),
      unsupportedCountry: state.unsupportedCountry, status: state.status || 'unconnected',
      reason: state.reason, businessName: state.businessName, accountId: state.accountId
    },
    r2: r2 ? { ...r2, status: 'ready' } : { status: 'unconnected' }, draft,
    chooseBucket: (path === '/setup/settings' && searchParams.get('bucket') === 'change') || ['/setup/r2', '/setup/r2/location'].includes(path),
    ...feedback
  });
}

export function filmmakerDashboard({ store, session, viewer, previewOrigin = viewer, searchParams, error,
  selectionFilm = searchParams?.get('film'), listedFilmIds, metricsOnly = false }) {
  const owner = session.owner;
  const films = store.dashboardFilms(owner, listedFilmIds);
  if (metricsOnly) return renderDashboard({ films, programs: store.programStats(owner), metricsOnly, completedDraft: false });
  return renderDashboard({
    ...store.dashboardDraft(owner), films, programs: store.programs(owner),
    csrf: session.csrf, owner: session.email || owner, error, origin: viewer, previewOrigin,
    selectionFilm, infoSaved: searchParams.get('saved') === 'details',
    selection: searchParams.getAll('include').join(','), poster: searchParams.get('poster')
  });
}
