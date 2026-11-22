import { DurableObject } from 'cloudflare:workers';
import { openDurableStore } from './sql-store.js';
import { callStore, pack } from '../src/store-wire.js';
import { workspaceResponse } from './workspace.js';

export class StreamStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = openDurableStore(ctx.storage, env.STREAM_VAULT_KEY);
    if (env.STREAM_ADMIN_EMAIL) this.store.enrollLogin('Stream operator', 'admin', env.STREAM_ADMIN_EMAIL);
  }

  // Private only: this method is not an HTTP route.
  call(method, args) {
    try {
      return { value: pack(callStore(this.store, method, args)) };
    } catch (error) {
      return {
        error: {
          name: error.name,
          message: error.message,
          status: error.status,
          statusCode: error.statusCode,
          code: error.code
        }
      };
    }
  }

  workspace(request) {
    return workspaceResponse(request, this.env, this.ctx, this.store);
  }
}
