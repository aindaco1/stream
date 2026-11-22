import assert from 'node:assert/strict';

const workspace = 'https://streamyourfilm.com', viewer = 'https://watch.streamyourfilm.com';
const faq = await fetch(workspace+'/faq',{redirect:'error'});
assert.equal(faq.status,200);
assert.match(await faq.text(),/FAQ/);
console.log('Public workspace FAQ is available.');
const secret = process.env.STREAM_MAINTENANCE_SECRET;
if (!secret) throw Error('Supply STREAM_MAINTENANCE_SECRET through your private operator environment to check the media runtime.');
const ready = await fetch(viewer+'/.well-known/stream-runtime',{
  redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+secret}
});
assert.equal(ready.status,200,'Hosted media runtime returned '+ready.status);
assert.deepEqual(await ready.json(),{workspace:true,viewer:true,isolatedFrame:true});
console.log('Both application listeners are ready. The production image decoded its synthetic frame through the isolated film input.');
const screening = await fetch(viewer+'/screening',{redirect:'error',signal:AbortSignal.timeout(15000)});
assert.equal(screening.status,200,'Public screening route returned '+screening.status);
assert.match(await screening.text(),/Screening room/);
console.log('The public viewer hostname reached its screening catalog.');
