import { Readable, addAbortSignal } from 'node:stream';
import yazl from 'yazl';
import { infoFields } from './film-embed.js';

// Only display metadata crosses the iframe boundary. Source bindings stay in the catalog.
export function programPresentation(spec, fields = infoFields) {
  return {
    title: spec.title, revision: spec.revision, previewId: spec.previewId,
    lineup: spec.lineup.map(({ id, role, title, duration, info, thumbnail, size, extension }) => ({
      id, role, title, duration, size, extension, thumbnail: Boolean(thumbnail),
      info: Object.fromEntries(fields.filter(field => info?.[field.name]).map(field => [field.name, info[field.name]]))
    }))
  };
}

function entryName(file, index) {
  const title = file.title.replace(/[\p{C}<>:"/\\|?*]/gu, ' ').trim().slice(0, 120).toWellFormed() || 'Film';
  const ext = ['mp4','mov','mkv'].includes(file.extension) ? file.extension : 'mp4';
  return String(index + 1).padStart(2, '0') + ' - ' + title + '.' + ext;
}

export function streamProgramArchive(files, signal, authorized) {
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  for (const [index, file] of files.entries()) {
    zip.addReadStreamLazy(entryName(file, index), { compress: false, size: file.size }, callback => {
      async function* bytes() {
        for await (const chunk of file.stream(0, file.size, signal)) {
          signal.throwIfAborted();
          if (!authorized()) throw new Error('Purchase unavailable.');
          yield chunk;
        }
      }
      const source = addAbortSignal(signal, Readable.from(bytes(), { objectMode:false }));
      source.on('error', error => zip.outputStream.destroy(error));
      callback(null, source);
    });
  }
  // Let the writer select ZIP64 only when a size or offset requires it.
  zip.end();
  return addAbortSignal(signal, zip.outputStream);
}
