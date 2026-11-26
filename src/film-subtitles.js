import { safeVtt } from './media-compat.js';
import { escapeHtml } from './film-embed.js';
import { hidden } from './offer-fields.js';

export const maxSrtBytes = 512 * 1024;
export function readSrt(bytes, duration) {
  if (!bytes.length || bytes.length > maxSrtBytes) throw Error('Choose a nonempty SRT file up to 512 KiB.');
  let raw;
  try { raw = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw Error('Save the SRT as UTF-8 and try again.'); }
  const blocks = raw.replace(/\r\n?/g,'\n').trim().split(/\n[ \t]*\n/);
  const time = '(\\d{2}:[0-5]\\d:[0-5]\\d),([0-9]{3})';
  const timing = new RegExp('^' + time + '\\s*-->\\s*' + time + '$');
  const cues = blocks.map((block,index) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = timing.exec(lines.shift()?.trim());
    if (!match || !lines.join('').trim() || match[1] + match[2] >= match[3] + match[4]) throw Error('Check the timing and text of SRT cue ' + (index+1) + '.');
    return match[1] + '.' + match[2] + ' --> ' + match[3] + '.' + match[4] + '\n' + lines.join('\n');
  });
  const vtt = safeVtt(cues.join('\n\n'),duration);
  if (!vtt.includes(' --> ')) throw Error('The SRT has no visible cues during this film.');
  if (new TextEncoder().encode(vtt).length > maxSrtBytes) throw Error('The converted subtitle track exceeds 512 KiB.');
  return vtt;
}

export function subtitleInfo(language, label, kind) {
  try {
    if (typeof language !== 'string' || !language.trim()) throw Error();
    language = new Intl.Locale(language.trim()).baseName;
  } catch { throw Error('Enter a language tag such as en or es-MX.'); }
  label = typeof label === 'string' ? label.trim() : '';
  if (language.length > 40 || !label || label.length > 60 || /[\p{C}<>"\\]/u.test(label) || !['subtitles','captions'].includes(kind)) throw Error('Choose a track type and enter a display label of up to 60 characters.');
  return {language,label,kind};
}

export function subtitleEditor(film, csrf, tracks) {
  const h = escapeHtml;
  const form = track => `<form class="film-form" method="post" enctype="multipart/form-data">
    ${hidden('csrf',csrf)}${hidden('track',track?.id ?? '')}${hidden('revision',film.revision)}
    <label>Track label<input name="label" maxlength="60" required value="${h(track?.label ?? '')}" placeholder="English SDH"></label>
    <label>Language tag<input name="language" required maxlength="40" value="${h(track?.language ?? '')}" placeholder="en"></label>
    <label>Track type<select name="kind"><option value="subtitles">Subtitles</option><option value="captions"${track?.kind==='captions'?' selected':''}>Captions (SDH)</option></select></label>
    <label>SRT file<input type="file" name="file" accept=".srt" required></label>
    <div class="film-actions"><button name="action" value="save">${track ? 'Replace track' : 'Add track'}</button>
    ${track ? '<button class="secondary" name="action" value="remove" formnovalidate>Remove track</button>' : ''}</div></form>`;
  const back = film.programId ? '<a href="/setup/program/'+h(film.programId)+'">Back to program</a>' :
    '<a href="/setup/dashboard#'+h(film.id)+'">Back to Dashboard</a>';
  return `${back}<h1>Subtitles for ${h(film.title)}</h1>
    <p>Upload UTF-8 SRT files up to 512 KiB. The viewer can select them alongside embedded tracks.</p>
    ${tracks.map(t=>'<details class="film-card"><summary>'+h(t.label)+' · '+h(t.language)+'</summary>'+form(t)+'</details>').join('')}
    <section class="film-card"><h2>Add a subtitle track</h2>${form()}</section>`;
}
