// Paths are relative to src for both the local server and the Worker asset build.
export const workspaceScripts = {
  '/setup/turnstile-size.js': '@dustwave/admin-shell/turnstile-browser',
  '/setup/header-session.js': '../public/header-session.js',
  '/setup/sign-in.js': '../public/sign-in.js',
  '/setup/appearance.js': '@dustwave/admin-shell/appearance-browser',
  '/setup/film-embed.js': './film-embed.js',
  '/setup/program-editor.js': '../public/program-editor.js',
  '/setup/field-help.js': '../public/field-help.js',
  '/setup/analytics-refresh.js': '../public/analytics-refresh.js',
  '/setup/dashboard.js': '../public/setup-dashboard.js',
  '/setup/thumbnail.js': '../public/thumbnail.js',
  '/setup/thumbnail-frame.js': './thumbnail-frame.js',
  '/setup/video-upload.js': '../public/video-upload.js',
  '/setup/navigation.js': '../public/setup-navigation.js',
  '/setup/tabs.js': '@dustwave/admin-shell/tabs',
  '/setup/tabs-browser.js': '@dustwave/admin-shell/tabs-browser'
};

export const workspaceAssets = {
  ...workspaceScripts,
  '/favicon.svg': '../public/favicon.svg',
  '/favicon.ico': '../public/favicon.ico',
  '/apple-touch-icon.png': '../public/apple-touch-icon.png',
  '/dust-wave-square.webp': '../public/dust-wave-square.webp',
  '/poster.css': '../public/poster.css',
  '/style.css': '../public/style.css',
  '/offer-display.js': '../public/offer-display.js',
  '/platform-tip.js': '@dustwave/worker-core/platform-tip',
  '/stripe-script.js': '../public/stripe-script.js',
  '/payment.js': '../public/payment.js',
  '/play-excerpt.js': '../public/play-excerpt.js',
  '/filmmaker-home.css': '../public/filmmaker-home.css',
  '/market-street-still.webp': '../public/market-street-still.webp',
  '/market-street-excerpt.mp4': '../public/market-street-excerpt.mp4',
  '/site-frame.css': '../public/site-frame.css',
  '/filmmaker.css': '../public/setup.css',
  '/filmmaker-dark.css': '../public/setup-dark.css',
  '/select-focus.js': '../public/select-focus.js',
  '/appearance.js': '@dustwave/admin-shell/appearance-browser'
};
