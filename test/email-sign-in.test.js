import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup } from '../src/setup.js';
import { makeServer } from '../src/server.js';

test('email login requires a verified challenge and a pre-enrolled address for that role', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-login-'));
  const messages = [];
  const actions = [];
  const setup = await createSetup({directory, env:{RESEND_API_KEY:'fixture',STREAM_RECOVERY_FROM:'film@example.test',
    STREAM_TURNSTILE_SECRET_KEY:'secret',STREAM_TURNSTILE_SITE_KEY:'public'},
    verifyChallenge:async (_req,_env,token,options) => {
      actions.push(options.action);
      return token === 'verified' ? {ok:true} : {ok:false,status:400};
    },
    mailFetch:async (_url,req) => { messages.push(JSON.parse(req.body)); return new Response('{}'); }
  });
  const app = await makeServer(null,{setup});
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve=>app.close(resolve)); setup.close(); await rm(directory,{recursive:true,force:true}); });
  const origin = 'http://127.0.0.1:' + app.address().port;
  const routes = ['/setup/sign-in','/setup/admin/sign-in'];
  const addresses = ['maker@example.test','operator@example.test'];
  const post = (path,data,source=origin) => fetch(origin+path,{method:'POST',redirect:'manual',headers:{Origin:source},body:new URLSearchParams(data)});
  const request = (path,email,token='verified',source) => post(path+'/request',{email,'cf-turnstile-response':token},source);
  for (const [i,path] of routes.entries()) {
    const role = i ? 'admin' : 'filmmaker';
    setup.store.invite('Pilot',role);
    setup.store.enrollLogin('Pilot',role,addresses[i]);
    assert.throws(()=>setup.store.enrollLogin('Pilot',role,'other@example.test'));
    assert.equal((await request(path,addresses[i],'verified','https://other.example')).status,403);
    assert.equal((await request(path,addresses[i],'')).status,400);
    const unknown = await (await request(path,addresses[1-i])).text();
    assert.equal(messages.length,i);
    const known = await (await request(path,addresses[i].toUpperCase())).text();
    assert.equal(known,unknown);
    await request(path,addresses[i]);
    assert.equal(messages.length,i+1);
    assert.equal(actions.at(-1),'stream_'+role);
    assert.deepEqual(messages[i].to,[addresses[i]]);
    const link = new URL(messages[i].text.match(/http:\S+/)[0]);
    assert.equal(link.origin,origin);
    assert.equal(link.pathname,path);
    assert.equal(link.search,'');
    const code = new URLSearchParams(link.hash.slice(1)).get('magic-link');
    assert.equal((await fetch(link)).status,200);
    assert.equal((await post(routes[1-i],{code})).status,401);
    const signedIn = await post(path,{code});
    assert.equal(signedIn.status,303);
    assert.match(signedIn.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await post(path,{code})).status,401);
  }
});
