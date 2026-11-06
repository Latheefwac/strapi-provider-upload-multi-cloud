/**
 * Filename normalization and collision-safe object-key generation.
 *
 * Responsibilities:
 *   - Normalize user filenames (spaces → hyphens, strip control chars, keep the
 *     extension) without changing them more than necessary.
 *   - Reject unsafe keys: path traversal, absolute paths, control characters,
 *     Windows drive letters, NUL bytes.
 *   - Append a cryptographically-random suffix in signed mode so uniqueness does
 *     not derive from the filename.
 *   - Produce incrementing candidate names for the "increment" collision
 *     strategy (`name.png`, `name-1.png`, `name-2.png`, ...).
 *
 * Key allocation itself (the atomic loop) lives in {@link ./index}; this module
 * is pure and therefore trivially unit-testable.
 */

import { randomBytes } from 'node:crypto';
import { InvalidKeyError } from './errors';
import type { FileNamingOptions } from './types';
import { joinKey } from './util';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Split a filename into its stem and extension (extension includes the dot). */
export function splitExtension(filename: string): { stem: string; ext: string } {
  const base = basename(filename);
  const dot = base.lastIndexOf('.');
  // A leading dot (dotfile) or no dot ⇒ no extension.
  if (dot <= 0) return { stem: base, ext: '' };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

/** Last path component, treating both `/` and `\` as separators. */
export function basename(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Normalize a filename stem. Preserves the extension (passed through by the
 * caller). The transform is intentionally conservative:
 *   - Unicode NFKC normalization,
 *   - optional whitespace → hyphen,
 *   - removal of characters outside a conservative key-safe set,
 *   - collapse of repeated separators and trimming.
 */
export function normalizeStem(stem: string, options: FileNamingOptions): string {
  let out = stem.normalize('NFKC').replace(CONTROL_CHARS, '');

  if (options.replaceSpacesWithHyphens) {
    out = out.replace(/\s+/g, '-');
  } else {
    // Even when not hyphenating, collapse whitespace so keys stay predictable.
    out = out.replace(/\s+/g, ' ').trim();
  }

  // Drop characters that are unsafe or ambiguous in object keys / URLs. Keep
  // Unicode letters and digits, plus a small punctuation set.
  out = out.replace(/[^\p{L}\p{N}._\- ]+/gu, '-');

  // Collapse separators and trim stray hyphens/dots/spaces from the ends.
  out = out
    .replace(/-{2,}/g, '-')
    .replace(/^[-.\s]+/, '')
    .replace(/[-\s]+$/, '');

  // Never allow an empty stem.
  return out.length ? out : 'file';
}

/** Full normalization of a filename (stem + preserved extension). */
export function normalizeFilename(filename: string, options: FileNamingOptions): string {
  const { stem, ext } = splitExtension(filename);
  return `${normalizeStem(stem, options)}${ext}`;
}

/** Cryptographically-strong lowercase-hex suffix of exactly `length` chars. */
export function generateHashSuffix(length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  return bytes.toString('hex').slice(0, length);
}

/**
 * Build the candidate *filename* (not the full key) for a given collision index.
 * Index 0 is the plain name; index N (>0) inserts `-N` before the extension.
 */
export function candidateFilename(stem: string, ext: string, index: number): string {
  if (index <= 0) return `${stem}${ext}`;
  return `${stem}-${index}${ext}`;
}

/**
 * Compute the filename for the first upload attempt.
 *
 * - Signed mode with `appendHashWhenSigned`: `<stem>-<hash><ext>` — uniqueness
 *   comes from the random hash, so repeated uploads never collide.
 * - Otherwise: the normalized `<stem><ext>` (collisions handled by the caller).
 */
export function buildPrimaryFilename(
  rawFilename: string,
  options: FileNamingOptions,
  signed: boolean,
): { stem: string; ext: string; filename: string } {
  const normalized = normalizeFilename(rawFilename, options);
  const { stem, ext } = splitExtension(normalized);

  if (signed && options.appendHashWhenSigned) {
    const suffix = generateHashSuffix(options.hashLength);
    return { stem, ext, filename: `${stem}-${suffix}${ext}` };
  }
  return { stem, ext, filename: `${stem}${ext}` };
}

/* -------------------------------------------------------------------------- */
/* Path / key safety                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Validate and normalize an *untrusted relative path* (e.g. an HLS file's
 * `webkitRelativePath`). Returns a clean POSIX path or throws
 * {@link InvalidKeyError}. Never resolves `.`/`..` away — it rejects them, so a
 * traversal attempt is a hard error rather than a silent escape.
 */
export function sanitizeRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new InvalidKeyError('Relative path is empty.');
  }
  if (input.includes('\u0000')) {
    throw new InvalidKeyError('Relative path contains a NUL byte.');
  }
  if (CONTROL_CHARS.test(input)) {
    throw new InvalidKeyError(`Relative path contains control characters: "${input}".`);
  }

  // Unify separators, then split.
  const unified = input.replace(/\\/g, '/');

  if (unified.startsWith('/')) {
    throw new InvalidKeyError(`Absolute paths are not allowed: "${input}".`);
  }
  // Windows drive-letter absolute path, e.g. "C:/..."
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new InvalidKeyError(`Drive-letter paths are not allowed: "${input}".`);
  }

  const segments = unified.split('/').filter((s) => s.length > 0 && s !== '.');
  for (const seg of segments) {
    if (seg === '..') {
      throw new InvalidKeyError(`Path traversal ("..") is not allowed: "${input}".`);
    }
  }
  if (segments.length === 0) {
    throw new InvalidKeyError(`Relative path resolves to nothing: "${input}".`);
  }
  return segments.join('/');
}

/**
 * Assert that a fully-composed object key is safe to send to a cloud backend.
 * This is the last line of defence before an SDK call.
 */
export function assertSafeKey(key: string): string {
  if (!key || key.length === 0) {
    throw new InvalidKeyError('Object key is empty.');
  }
  if (key.length > 1024) {
    throw new InvalidKeyError(`Object key exceeds 1024 bytes: "${key.slice(0, 64)}…".`);
  }
  if (key.includes('\u0000')) {
    throw new InvalidKeyError('Object key contains a NUL byte.');
  }
  if (CONTROL_CHARS.test(key)) {
    throw new InvalidKeyError('Object key contains control characters.');
  }
  if (key.startsWith('/')) {
    throw new InvalidKeyError(`Object key must not start with "/": "${key}".`);
  }
  if (key.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new InvalidKeyError(`Object key contains "." or "..": "${key}".`);
  }
  return key;
}

/**
 * Compose a safe object key from an optional root prefix, an optional folder
 * prefix and a filename. All parts are joined with single slashes; the result
 * is validated with {@link assertSafeKey}.
 */
export function composeKey(parts: {
  rootPath?: string;
  folderPath?: string;
  filename: string;
}): string {
  const key = joinKey(parts.rootPath, parts.folderPath, parts.filename);
  return assertSafeKey(key);
}
