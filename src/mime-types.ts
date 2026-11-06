/**
 * Extension → MIME type mapping, with an emphasis on HLS assets.
 *
 * Strapi usually provides `file.mime`, but HLS packages are uploaded as raw
 * files whose declared MIME types are frequently wrong or missing (browsers
 * send `application/octet-stream` for `.ts`, `.m4s`, `.key`, etc.). The HLS
 * pipeline and the drivers use this map to set an accurate `Content-Type`,
 * which players and CDNs rely on.
 *
 * The map is intentionally maintainable: add a row and both the provider and
 * the HLS plugin pick it up.
 */

export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  // --- HLS core (required by the task) ---
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt',
  '.key': 'application/octet-stream',

  // --- Sensible additional streaming / media formats ---
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.srt': 'application/x-subrip',
  '.cmfv': 'video/mp4',
  '.cmfa': 'audio/mp4',
  '.init': 'video/iso.segment',

  // --- Common image/doc types (ordinary media library) ---
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
});

const DEFAULT_MIME = 'application/octet-stream';

/** Lower-cased extension (including the leading dot) for a filename or key. */
export function extname(name: string): string {
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * Resolve the MIME type for a filename/key.
 *
 * Preference order: an explicit extension match, then a non-generic
 * `fallbackMime` supplied by Strapi, then `application/octet-stream`.
 */
export function resolveMimeType(name: string, fallbackMime?: string): string {
  const ext = extname(name);
  const mapped = ext ? MIME_BY_EXTENSION[ext] : undefined;
  if (mapped) return mapped;
  if (fallbackMime && fallbackMime !== DEFAULT_MIME) return fallbackMime;
  return DEFAULT_MIME;
}

/** Encryption-key assets must never be served publicly. */
export function isEncryptionKey(name: string): boolean {
  return extname(name) === '.key';
}

/** Whether a filename looks like an HLS playlist. */
export function isPlaylist(name: string): boolean {
  const ext = extname(name);
  return ext === '.m3u8' || ext === '.m3u';
}
