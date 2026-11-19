import { playbackSettings } from '../src/operator.js';
import { openFilm } from '../src/media.js';
import { filmSpec, sourceFromEnv } from '../src/config.js';

const id = process.argv[2] || 'clock';
const spec = filmSpec(id);
if (!spec || process.argv.length > 3) throw new Error('Choose clock, second or feature.');
const env = await playbackSettings({ maker: spec.maker });
const film = await openFilm(sourceFromEnv(env, spec.maker));
try {
  console.log(JSON.stringify({
    id, maker: spec.maker, film: spec.scope, revision: film.revision,
    duration: film.duration, segments: film.segments.length
  }));
} finally {
  film.close();
}
