import { DatabaseSync } from 'node:sqlite';
import { rentalReference } from '../src/rental-reference.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeServer } from '../src/server.js';
import { createSetup } from '../src/setup.js';

test('operator-only analytics has its own invitations, session, directory and sign-out', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-admin-'));
  const contacts = [];
  const setup = await createSetup({ directory, env: {}, viewerCheckout:{
    async rentalCustomer(id) { contacts.push(id); return 'viewer@example.test'; }
  }});
  const { store } = setup;
  const app = await makeServer(null, { setup });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    setup.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + app.address().port;
  const get = (path, cookie = '') => fetch(origin + path, { redirect: 'manual', headers: { Cookie: cookie } });
  const post = (path, data, cookie = '') => fetch(origin + path, { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams(data) });
  const maker = store.invite('Owner');
  const admin = store.invite('Owner', 'admin');
  for (let i = 0; i < 25; i++) store.invite('Zero films ' + String(i).padStart(2,'0'));
  assert.equal((await get('/setup/admin')).headers.get('location'), '/admin/sign-in');
  assert.equal((await post('/setup/sign-in', { code: admin })).status, 401);
  assert.equal((await post('/setup/admin/sign-in', { code: maker })).status, 401);
  const filmmaker = await post('/setup/sign-in', { code: maker });
  const ordinaryCookie = filmmaker.headers.get('set-cookie').split(';')[0];
  const ordinaryAsAdmin = ordinaryCookie.replace('stream_setup=', 'stream_admin=');
  assert.equal((await get('/setup/admin', ordinaryAsAdmin)).status, 303);

  const login = await post('/setup/admin/sign-in', { code: admin });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/setup/admin');
  const header = login.headers.get('set-cookie');
  assert.match(header, /Path=\/setup\/admin/i);
  assert.match(header, /HttpOnly/i);
  const cookie = header.split(';')[0];
  assert.equal((await post('/setup/admin/sign-in', { code: admin })).status, 401);
  assert.equal((await get('/setup/dashboard', cookie.replace('stream_admin=', 'stream_setup='))).status, 303);
  const home = await get('/setup/admin', cookie);
  assert.equal(home.status, 200);
  const page = await home.text();
  assert.match(page, /26 filmmakers/);
  assert.match(page, /Page 1 of 2/);
  assert.doesNotMatch(page, /Zero films 24/);
  assert.match(await (await get('/setup/admin?page=999', cookie)).text(), /Zero films 24/);
  assert.equal((await get('/setup/admin?maker=Missing', cookie)).status, 404);
  assert.match(await (await get('/setup/admin?maker=Owner', cookie)).text(), /0 films/);
  assert.equal((await post('/setup/admin', {}, cookie)).status, 404);
  assert.equal((await post('/setup/admin/sign-out', { csrf: 'wrong' }, cookie)).status, 403);
  const { csrf } = store.session(cookie.split('=')[1], 'admin');
  const lookup = '/setup/admin/watermark';
  const code = rentalReference('film','order');
  assert.match(page,/Rental watermark lookup/);
  assert.equal((await post(lookup,{code,csrf},ordinaryAsAdmin)).status,401);
  assert.equal((await post(lookup,{code,csrf:'invalid'},cookie)).status,403);
  assert.equal((await post(lookup,{code:'123XYZ',csrf},cookie)).status,400);
  assert.equal((await fetch(origin+lookup,{method:'POST',headers:{Cookie:cookie,Origin:'https://elsewhere.example'},
    body:new URLSearchParams({code,csrf})})).status,403);
  assert.match(await (await post(lookup,{code,csrf},cookie)).text(),/No paid rental matches/);
  const db = new DatabaseSync(join(directory,'setup.sqlite'));
  const insert = db.prepare(`INSERT INTO viewer_test_orders(tokenHash,orderId,filmId,owner,account,scope,revision,platform,title,origin,
    createdAt,kind,paidAt,intentId,rentalReference) VALUES(?,?,'film','Maker','acct','film','1','platform','Film',?,1,?,1,?,?)`);
  for (let i=0;i<101;i++) insert.run('digest'+i,'old'+i,origin,'rent','pi_old'+i,null);
  insert.run('digest','order',origin,'rent','pi_synthetic',null);
  insert.run('buy','buyer',origin,'buy','pi_purchase',code);
  assert.match(await (await post(lookup,{code,csrf},cookie)).text(),/Continue lookup/);
  assert.deepEqual(contacts,[]);
  const match = await post(lookup,{code:code.toLowerCase(),csrf},cookie);
  assert.match(match.headers.get('cache-control'),/no-store/);
  assert.match(await match.text(),/viewer@example.test/);
  assert.deepEqual(contacts,['order']);
  insert.run('other','another',origin,'rent','pi_collision',code);
  const ambiguous = await (await post(lookup,{code,csrf},cookie)).text();
  assert.match(ambiguous,/Several rentals share/);
  assert.match(ambiguous,/pi_synthetic/);
  assert.match(ambiguous,/pi_collision/);
  assert.doesNotMatch(ambiguous,/viewer@example.test|pi_purchase/);
  assert.deepEqual(contacts,['order']);
  db.close();
  assert.equal((await post('/setup/admin/sign-out', { csrf }, cookie)).status, 303);
  assert.equal((await get('/setup/admin', cookie)).status, 303);
  assert.equal((await get('/setup/dashboard', ordinaryCookie)).status, 200);
});

test('manual Tax fee review requires a live super-admin session, matching origin, and its CSRF token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-admin-fee-'));
  const publicOrigin = 'https://stream.example';
  let checks = 0;
  const setup = await createSetup({directory,env:{STRIPE_CONNECT_LIVE:'1',STREAM_PUBLIC_ORIGIN:publicOrigin,STREAM_VIEWER_ORIGIN:'https://watch.example'},
    viewerCheckout:{platformId:async () => {checks++;return 'acct_platform';}}});
  const app=await makeServer(null,{setup});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));setup.close();await rm(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port;
  const admin=setup.store.signIn(setup.store.invite('Reviewer','admin'),'admin');
  const maker=setup.store.signIn(setup.store.invite('Maker'));
  const path='/setup/admin/tax-fees';
  const post=(cookie,csrf,origin=base)=>fetch(base+path,{method:'POST',redirect:'manual',headers:{Origin:origin,Cookie:cookie},
    body:new URLSearchParams({csrf,charge:'x',report:'y'})});
  assert.equal((await post('','')).status,401);
  assert.equal((await post('stream_admin='+maker,'x')).status,401);
  assert.equal((await post('stream_admin='+admin,'x')).status,403);
  const csrf=setup.store.session(admin,'admin').csrf;
  assert.equal((await post('stream_admin='+admin,csrf,'https://another.example')).status,403);
  assert.equal(checks,0);
  const page=await fetch(base+path,{headers:{Cookie:'stream_admin='+admin}});
  assert.equal(page.status,200);
  assert.match(await page.text(),/No fees are waiting/);
  assert.equal((await post('stream_admin='+admin,csrf)).status,422);
  const report = '/setup/admin/new-mexico.csv?month=2026-11';
  assert.equal((await fetch(base+report,{headers:{Cookie:'stream_admin='+maker},redirect:'manual'})).status,303);
  const csv = await fetch(base+report,{headers:{Cookie:'stream_admin='+admin}});
  assert.equal(csv.status,200);
  assert.equal(csv.headers.get('cache-control'),'no-store');
  assert.match(csv.headers.get('content-disposition'),/stream-nm-2026-11.csv/);
  assert.match(await csv.text(),/nm_reporting_location/);
});
