import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { readBoundedJson } from '@dustwave/worker-core/response-body';
import { timingSafeEqual } from '@dustwave/worker-core/crypto';
import { unpack } from '../src/store-wire.js';
import { isPublicWorkspaceRequest } from './workspace.js';
import { publicViewerBasics } from './viewer-basics.js';
export { StreamStore } from './store.js';

const sites = new Map([['streamyourfilm.com',8792],['watch.streamyourfilm.com',8793]]);
const idleMs = 120_000;

export class StoreBridge extends WorkerEntrypoint {
  async fetch(request) {
    const secret = this.env.STREAM_STORE_TOKEN;
    const url = new URL(request.url);
    if (url.hostname !== '192.0.2.1' || url.pathname !== '/call' || request.method !== 'POST' ||
        !secret || !timingSafeEqual(request.headers.get('Authorization') ?? '', 'Bearer ' + secret)) {
      return new Response(null,{status:403});
    }
    const { method,args } = await readBoundedJson(request, 4 * 1024 * 1024);
    const result = await this.env.STREAM_STORE.getByName('pilot-live').call(method,unpack(args));
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }
}

export class StreamRuntime extends DurableObject {
  async start() {
    const container = this.ctx.container;
    // Installing the intercept before starting the processes also covers a new
    // container after eviction. The reserved address needs no DNS resolution.
    await container.interceptOutboundHttp('192.0.2.1:80',this.ctx.exports.StoreBridge());
    if (!container.running) {
      const allowed = ['STREAM_STORE_TOKEN','STREAM_MAINTENANCE_SECRET','STREAM_RENTAL_SECRET','STREAM_RECOVERY_FROM',
        'RESEND_API_KEY','STREAM_TURNSTILE_SITE_KEY','STREAM_TURNSTILE_SECRET_KEY','STREAM_SALES_TERRITORIES','STREAM_NM_MANUAL_TAX',
        'STRIPE_CONNECT_SECRET_KEY','STRIPE_CONNECT_PUBLISHABLE_KEY','STRIPE_CONNECT_WEBHOOK_SECRET',
        'STRIPE_PLATFORM_WEBHOOK_SECRET','STRIPE_CONNECT_CLIENT_ID'];
      const secrets = Object.fromEntries(allowed.filter(key => this.env[key]).map(key => [key,this.env[key]]));
      container.start({ image:container.images.base, instance:{vcpu:1,memoryMib:2048,diskMb:4096},
        enableInternet:true, env:{ ...secrets,STRIPE_CONNECT_LIVE:'1',STREAM_STRIPE_TAX_MODE:'marketplace',
          STREAM_WORKSPACE_ORIGIN:'https://streamyourfilm.com',STREAM_VIEWER_ORIGIN:'https://watch.streamyourfilm.com' } });
    }
    await container.setInactivityTimeout(idleMs);
    const readiness = container.getTcpPort(8791);
    for (let attempt=0; attempt<100; attempt++) {
      try {
        const response = await readiness.fetch('http://container/ready',{signal:AbortSignal.timeout(1000)});
        await response.body?.cancel();
        if (response.status === 204) { this.healthy = true; return; }
      } catch { /* The listeners have not started yet. */ }
      await scheduler.wait(250);
    }
    throw new Error('Stream has not finished starting.');
  }

  async ready() {
    if (this.healthy && this.ctx.container.running) {
      await this.ctx.container.setInactivityTimeout(idleMs);
      return;
    }
    this.healthy = false;
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const port = sites.get(url.hostname);
    if (!port || url.protocol !== 'https:' || url.port) return new Response(null,{status:404});
    await this.ready();
    url.protocol = 'http:';
    const forwarded = new Request(url,request);
    forwarded.headers.set('Host',url.hostname);
    return this.ctx.container.getTcpPort(port).fetch(forwarded);
  }

  async checkRuntime() {
    await this.ready();
    return {workspace:true,viewer:true,isolatedFrame:true};
  }

  async reconcile() {
    await this.ready();
    const response = await this.ctx.container.getTcpPort(8794).fetch('http://container/reconcile',{
      method:'POST',headers:{Authorization:'Bearer '+this.env.STREAM_MAINTENANCE_SECRET}
    });
    if (!response.ok) throw Error('Stream reconciliation did not finish.');
  }
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    if (!sites.has(url.hostname) || url.protocol !== 'https:' || url.port) return new Response(null,{status:404});
    // These routes have a single owner. Signing in never depends on a media VM.
    if (url.hostname === 'streamyourfilm.com' && isPublicWorkspaceRequest(request)) {
      return env.STREAM_STORE.getByName('pilot-live').workspace(request);
    }
    if (url.hostname === 'watch.streamyourfilm.com') {
      const page = publicViewerBasics(request,env);
      if (page) return page;
    }
    const probe = url.hostname === 'watch.streamyourfilm.com' && url.pathname === '/.well-known/stream-runtime';
    if (probe && (request.method !== 'GET' || !env.STREAM_MAINTENANCE_SECRET ||
        !timingSafeEqual(request.headers.get('Authorization') ?? '', 'Bearer '+env.STREAM_MAINTENANCE_SECRET))) {
      return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
    }
    try {
      const runtime = env.STREAM_RUNTIME.getByName('pilot-origin');
      if (probe) return Response.json(await runtime.checkRuntime(),{headers:{'Cache-Control':'private, no-store'}});
      return await runtime.fetch(request);
    }
    catch { return new Response('Stream is temporarily unavailable. Please try again shortly.',{
      status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}
    }); }
  },
  async scheduled(event,env) {
    const result = await env.STREAM_STORE.getByName('pilot-live').call('needsPaymentSweep',[]);
    if (result.error) throw Error('Stream could not check for pending payment work.');
    if (result.value) await env.STREAM_RUNTIME.getByName('pilot-origin').reconcile();
  }
};
