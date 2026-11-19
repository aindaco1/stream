import { playbackSettings } from '../src/operator.js';
import { openFilm } from '../src/media.js';
import { sourceFromEnv } from '../src/config.js';

const film = await openFilm(sourceFromEnv(await playbackSettings()));
try {
  console.log(JSON.stringify({ film: 'clock', revision: film.revision, duration: film.duration, segments: film.segments.length }));
} finally {
  film.close();
}
