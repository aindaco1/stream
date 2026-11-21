import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { agreementPath, agreementVersion } from '../src/filmmaker-agreement.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup } from '../src/setup.js';
import { makeServer } from '../src/server.js';

async function fixture(t) {
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
  const post = (path,data,source=origin) => fetch(origin+path,{method:'POST',redirect:'manual',headers:{Origin:source},body:new URLSearchParams(data)});
  const request = (path,email,token='verified',source) => post(path+'/request',{email,'cf-turnstile-response':token},source);
  return { setup, messages, actions, origin, directory, post, request };
}

test('email login requires a verified challenge and an enrolled address for that role', async t => {
  const { setup, messages, actions, origin, post, request } = await fixture(t);
  const routes = ['/setup/sign-in','/setup/admin/sign-in'];
  const addresses = ['maker@example.test','operator@example.test'];
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

test('public signup creates one filmmaker only after verified email and agreement confirmation', async t => {
  const { directory, messages, origin, actions, post, setup } = await fixture(t);
  const db = new DatabaseSync(join(directory, 'setup.sqlite'));
  t.after(() => db.close());
  const signup = '/setup/sign-up';
  const home = await fetch(origin + '/');
  assert.match(await home.text(), /Create your filmmaker workspace/);
  assert.match(await (await fetch(origin + agreementPath)).text(), /no ownership, distribution rights, exclusivity or royalties/);
  const fields = {email:'New@Example.test', agreement:agreementVersion, 'cf-turnstile-response':'verified'};
  const submit = (overrides, source) => post(signup + '/request', {...fields, ...overrides}, source);
  assert.equal((await submit({agreement:''})).status, 400);
  assert.equal((await submit({agreement:'old-version'})).status, 400);
  assert.equal((await submit({'cf-turnstile-response':''})).status, 400);
  assert.equal((await submit({},'https://other.example')).status, 403);
  assert.equal(messages.length, 0);
  const confirmation = await (await submit({})).text();
  assert.match(confirmation, /Check your inbox/);
  assert.equal(await (await submit({})).text(), confirmation);
  assert.deepEqual(messages[0].to, ['new@example.test']);
  assert.equal(messages.length, 1);
  assert.equal(actions.at(-1), 'stream_signup');
  const link = new URL(messages[0].text.match(/http:\S+/)[0]);
  const code = new URLSearchParams(link.hash.slice(1)).get('magic-link');
  assert.equal(link.pathname, signup);
  assert.equal((await fetch(link)).headers.has('set-cookie'), false);
  assert.equal((await post('/setup/admin/sign-in', {code})).status, 401);
  assert.equal((await post('/setup/sign-in', {code})).status, 401);
  assert.equal((await post(signup, {code,agreement:'old-version'})).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM makers').get().n, 0);
  const responses = await Promise.all([1,2].map(() => post(signup,{code,agreement:agreementVersion})));
  assert.deepEqual(responses.map(r => r.status).sort(), [303,401]);
  const cookie = responses.find(r => r.status === 303).headers.get('set-cookie').split(';')[0];
  const receipt = db.prepare('SELECT * FROM filmmaker_agreements').get();
  assert.equal(receipt.email,'new@example.test');
  assert.equal(receipt.version,agreementVersion);
  assert.ok(receipt.confirmedAt >= receipt.requestedAt);
  assert.ok(setup.store.maker(receipt.owner));
  assert.notEqual(receipt.owner, receipt.email);
  assert.equal((await fetch(origin+'/setup/home',{headers:{cookie},redirect:'manual'})).headers.get('location'), '/setup/dashboard');
  assert.match(await (await fetch(origin+'/setup/dashboard',{headers:{cookie}})).text(), /Signed in as new@example.test/);
  assert.equal((await fetch(origin+'/setup/admin',{headers:{cookie},redirect:'manual'})).headers.get('location'), '/setup/admin/sign-in');

  setup.store.enrollLogin('Original filmmaker','filmmaker','existing@example.test');
  assert.equal(await (await submit({email:'EXISTING@example.test'})).text(),confirmation);
  const returning = new URL(messages.at(-1).text.match(/http:\S+/)[0]);
  assert.equal(returning.pathname, '/setup/sign-in');
  const access = await post(returning.pathname,{code:new URLSearchParams(returning.hash.slice(1)).get('magic-link')});
  const session = access.headers.get('set-cookie').split(';')[0].split('=')[1];
  assert.equal(setup.store.session(session).owner,'Original filmmaker');
  assert.equal(db.prepare('SELECT count(*) AS n FROM makers').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM filmmaker_agreements').get().n,1);
  const expired = setup.store.requestSignup('expired@example.test',agreementVersion);
  db.prepare('UPDATE signup_links SET expires=0 WHERE email=?').run(expired.email);
  assert.equal(setup.store.confirmSignup(expired.code,agreementVersion),undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM makers').get().n,2);
});
