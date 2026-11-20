// Shared by the canvas preview and the final image renderer.
export const centerFrame = { x: 50, y: 50, zoom: 100 };
export function cropRect(width, height, { x, y, zoom }) {
  const scale = Math.min(width / 16, height / 9) * 100 / zoom;
  const w = Math.max(1, Math.min(width, Math.round(scale * 16)));
  const h = Math.max(1, Math.min(height, Math.round(scale * 9)));
  return { left: Math.round((width - w) * x / 100), top: Math.round((height - h) * y / 100), width: w, height: h };
}

export function thumbnailKey(id) { return 'stream-thumbnails/' + id + '.jpg'; }
