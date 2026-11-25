export function publicViewerBasics(request,env) {
  if (!['GET','HEAD'].includes(request.method)) return;
  const path = new URL(request.url).pathname;
  if (path === '/') return Response.redirect('https://streamyourfilm.com/',303);
  if (path === '/faq' || path === '/privacy') return Response.redirect('https://streamyourfilm.com' + path,303);
  if (['/favicon.svg','/favicon.ico','/apple-touch-icon.png'].includes(path)) return env.ASSETS.fetch(request);
  if (path === '/robots.txt') return new Response(request.method === 'HEAD' ? null : 'User-agent: *\nDisallow: /\n',{
    headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=3600'}
  });
}
