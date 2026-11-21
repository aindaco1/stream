import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingCaption } from '../public/subtitles.js';

const selected = {source:'first', id:'s2', language:'eng', label:'English SDH', kind:'captions', format:'text'};
const french = {...selected, language:'fr', label:'French'};
const english = {...selected, id:'s4', language:'en', format:'bitmap'};

test('a title owns its track numbers, while another title matches caption language and type', () => {
  assert.equal(matchingCaption([french, english], selected, 'first'), french);
  assert.equal(matchingCaption([french, {...english, kind:'subtitles'}, english], selected, 'next'), english);
  assert.equal(matchingCaption([french], selected, 'next'), undefined);
  assert.equal(matchingCaption([english], undefined, 'next'), undefined);
  assert.equal(matchingCaption([{...english, forced:true}], selected, 'next'), undefined);
});

test('regional tags have a language fallback and untagged tracks require a meaningful label', () => {
  const brazil = {...selected, language:'pt-BR'};
  const regional = {...english, language:'pt-PT'};
  assert.equal(matchingCaption([french, regional], brazil, 'next'), regional);
  const nameless = {...english, language:'und', label:'Subtitle track 2'};
  assert.equal(matchingCaption([nameless], {...nameless, source:'first'}, 'next'), undefined);
  const named = {...nameless, label:'Mandarin'};
  assert.equal(matchingCaption([named], {...named, source:'first'}, 'next'), named);
});
