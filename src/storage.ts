/**
 * Storage factory — the shared core imported by both the upload provider
 * ({@link ./index}) and the companion HLS/folder plugin.
 *
 * Exposing `createDriver`/`validateConfig` here (via the package's "./storage"
 * entry point) means there is exactly one driver implementation per cloud, used
 * identically for media-library uploads, HLS packages and folder moves.
 */

import { S3Driver } from './drivers/s3';
import { GcsDriver } from './drivers/gcs';
import { AzureDriver } from './drivers/azure';
import { ProviderError } from './errors';
import type { ProviderOptions, StorageDriver } from './types';
import { trimSlashes } from './util';

export { validateConfig } from './config';
export * from './types';
export * from './errors';
export {
  normalizeFilename,
  normalizeStem,
  splitExtension,
  generateHashSuffix,
  candidateFilename,
  buildPrimaryFilename,
  sanitizeRelativePath,
  assertSafeKey,
  composeKey,
} from './naming';
export { resolveMimeType, extname, isEncryptionKey, isPlaylist, MIME_BY_EXTENSION } from './mime-types';
export { mapWithConcurrency, joinKey, trimSlashes, normalizeSlashes } from './util';

/** Instantiate the driver for the configured cloud. Never falls back silently. */
export function createDriver(options: ProviderOptions): StorageDriver {
  switch (options.provider) {
    case 's3':
      if (!options.s3) throw new ProviderError('CONFIG_INVALID', 'Missing s3 options.');
      return new S3Driver(options.s3);
    case 'gcs':
      if (!options.gcs) throw new ProviderError('CONFIG_INVALID', 'Missing gcs options.');
      return new GcsDriver(options.gcs);
    case 'azure':
      if (!options.azure) throw new ProviderError('CONFIG_INVALID', 'Missing azure options.');
      return new AzureDriver(options.azure);
    default:
      throw new ProviderError(
        'DRIVER_UNSUPPORTED',
        `Unsupported provider "${(options as { provider?: string }).provider}".`,
      );
  }
}

/** The configured root prefix for the active cloud (normalized, no slashes). */
export function getRootPath(options: ProviderOptions): string {
  const raw =
    options.provider === 's3'
      ? options.s3?.rootPath
      : options.provider === 'gcs'
        ? options.gcs?.rootPath
        : options.azure?.rootPath;
  return raw ? trimSlashes(raw) : '';
}
