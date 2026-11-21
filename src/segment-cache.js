// Each open film has its own keys. All films share one eviction order and budget.
export function createSegmentCache(maxBytes, maxEntries) {
  const recent = new Set();
  let usedBytes = 0;

  function remove(entry) {
    recent.delete(entry);
    entry.film.delete(entry.key);
    usedBytes -= entry.size;
  }

  return function openFilmCache() {
    const film = new Map();
    return {
      get(key) {
        const entry = film.get(key);
        if (!entry) return;
        recent.delete(entry);
        recent.add(entry);
        return entry.bytes;
      },
      set(key, bytes) {
        const previous = film.get(key);
        if (previous) remove(previous);
        // A Buffer slice can retain a backing allocation larger than the slice.
        const size = bytes.buffer.byteLength;
        if (!size || size > maxBytes) return;
        while (recent.size >= maxEntries || usedBytes + size > maxBytes) {
          remove(recent.values().next().value);
        }
        const entry = { film, key, bytes, size };
        film.set(key, entry);
        recent.add(entry);
        usedBytes += size;
      },
      clear() {
        for (const entry of film.values()) remove(entry);
      }
    };
  };
}
