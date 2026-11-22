import { publicViewerBasics } from './viewer-basics.js';
export { StreamStore } from './store.js';

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'streamyourfilm.com') {
      return env.STREAM_STORE.getByName('pilot-live').workspace(request);
    }
    if (url.hostname === 'watch.streamyourfilm.com') {
      const page = publicViewerBasics(request,env);
      if (page) return page;
      return new Response('Public film playback is being set up.', { status:503,headers:{
        'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Retry-After':'3600','X-Robots-Tag':'noindex'
      } });
    }
    return new Response('Unknown hostname.', { status:404 });
  }
};
