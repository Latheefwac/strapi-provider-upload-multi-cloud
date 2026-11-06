/**
 * strapi-provider-upload-multi-cloud-storage
 *
 * A Strapi 5 upload provider with a unified interface over AWS S3, Google Cloud
 * Storage and Azure Blob Storage.
 *
 * Implements the provider contract: init(providerOptions) → { upload,
 * uploadStream, delete, checkFileSize, getSignedUrl, isPrivate }.
 *
 * IMPORTANT: this module uses `module.exports = { init }` (NOT `export default`).
 * Under CommonJS, `export default` compiles to `module.exports.default`, which
 * makes Strapi's `provider.init(...)` throw "init is not a function".
 */

import type { Readable } from 'node:stream';
import { allocateBuffer, allocateStream } from './allocate';
import { validateConfig } from './config';
import { logger } from './logger';
import { resolveMimeType, isEncryptionKey } from './mime-types';
import { createDriver, getRootPath } from './storage';
import type {
  ProviderOptions,
  PutObjectOptions,
  StorageDriver,
  StrapiFile,
} from './types';
import { joinKey, normalizeSlashes } from './util';

interface InitResult {
  upload(file: StrapiFile): Promise<void>;
  uploadStream(file: StrapiFile): Promise<void>;
  delete(file: StrapiFile): Promise<void>;
  checkFileSize(file: StrapiFile, options: { sizeLimit?: number }): void;
  getSignedUrl(file: StrapiFile): Promise<{ url: string }>;
  isPrivate(): boolean;
}

/** Translate a Strapi folder path to a cloud prefix (via the optional resolver). */
async function resolveFolderPrefix(
  file: StrapiFile,
  options: ProviderOptions,
): Promise<string> {
  if (!options.folders.preserveHierarchy) return '';
  const folderPath = (file.folderPath || file.path || '').trim();
  if (!folderPath || folderPath === '/') return '';

  if (typeof options.folderPrefixResolver === 'function') {
    try {
      const resolved = await options.folderPrefixResolver(folderPath);
      if (resolved) return normalizeSlashes(resolved);
    } catch (err) {
      logger.warn('folderPrefixResolver failed; falling back to numeric path', {
        folderPath,
        error: (err as Error).message,
      });
    }
  }
  // Fallback: Strapi's numeric folder path (e.g. "/1/5" → "1/5"), which keeps
  // the hierarchy and is stable per folder (pathIds are immutable).
  return normalizeSlashes(folderPath);
}

/** Compose the key prefix (root + folder) for a file. */
async function computePrefix(file: StrapiFile, options: ProviderOptions): Promise<string> {
  const root = getRootPath(options);
  const folder = await resolveFolderPrefix(file, options);
  return joinKey(root, folder);
}

/** PutObject options derived from the file and provider config. */
function putOptionsFor(file: StrapiFile, key: string, options: ProviderOptions): PutObjectOptions {
  const signed = options.signedUrl.enabled;
  const keyAsset = isEncryptionKey(file.name) || isEncryptionKey(key);
  const isPrivate = signed || keyAsset;
  return {
    contentType: resolveMimeType(file.name, file.mime),
    cacheControl: isPrivate ? options.privateCacheControl : options.publicCacheControl,
    isPrivate,
    metadata: {
      'original-name': encodeURIComponent(file.name).slice(0, 1024),
      hash: file.hash,
    },
  };
}

/** Recover the object key for an already-stored file (for delete / signing). */
function keyFromFile(file: StrapiFile, driver: StorageDriver): string {
  const metaKey = file.provider_metadata?.key;
  if (typeof metaKey === 'string' && metaKey.length) return metaKey;

  // Fallback: strip the public base URL and decode the path segments.
  const base = driver.getPublicUrl(''); // "<baseUrl>/"
  let rest = file.url;
  if (rest.startsWith(base)) rest = rest.slice(base.length);
  else {
    // URL from a different base (e.g. provider changed): best effort via pathname.
    try {
      rest = new URL(file.url).pathname.replace(/^\/+/, '');
    } catch {
      rest = rest.replace(/^\/+/, '');
    }
  }
  return rest
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

function setFileResult(
  file: StrapiFile,
  key: string,
  driver: StorageDriver,
  options: ProviderOptions,
): void {
  // Always store the STABLE, unsigned public URL in file.url so the Media
  // Library never persists an expiring signed URL. In private mode this URL is
  // not directly fetchable; the admin signs it on demand via getSignedUrl().
  file.url = driver.getPublicUrl(key);
  file.provider_metadata = {
    ...(file.provider_metadata ?? {}),
    provider: driver.provider,
    key,
    private: options.signedUrl.enabled,
  };
}

module.exports = {
  init(rawOptions: unknown): InitResult {
    const options = validateConfig(rawOptions);
    const driver = createDriver(options);

    logger.info('provider initialized', {
      provider: options.provider,
      signed: options.signedUrl.enabled,
      preserveHierarchy: options.folders.preserveHierarchy,
    });

    // Fail fast if signing is requested but the driver cannot sign.
    if (options.signedUrl.enabled) {
      void driver.canSign().then((ok) => {
        if (!ok) {
          logger.error(
            'signedUrl.enabled is true but the configured credentials cannot generate signed URLs',
            { provider: options.provider },
          );
        }
      });
    }

    return {
      async upload(file: StrapiFile): Promise<void> {
        if (!file.buffer) {
          throw new Error(`File "${file.name}" has no buffer for upload().`);
        }
        const prefix = await computePrefix(file, options);
        const putOpts = putOptionsFor(file, joinKey(prefix, file.name), options);
        const key = await allocateBuffer(
          { driver, prefix, rawFilename: file.name, fileNaming: options.fileNaming, signed: options.signedUrl.enabled, putOptions: putOpts },
          file.buffer,
        );
        setFileResult(file, key, driver, options);
        logger.debug('uploaded (buffer)', { key, provider: options.provider });
      },

      async uploadStream(file: StrapiFile): Promise<void> {
        if (!file.stream) {
          throw new Error(`File "${file.name}" has no stream for uploadStream().`);
        }
        const prefix = await computePrefix(file, options);
        const putOpts = putOptionsFor(file, joinKey(prefix, file.name), options);
        const key = await allocateStream(
          { driver, prefix, rawFilename: file.name, fileNaming: options.fileNaming, signed: options.signedUrl.enabled, putOptions: putOpts },
          file.stream as Readable,
        );
        setFileResult(file, key, driver, options);
        logger.debug('uploaded (stream)', { key, provider: options.provider });
      },

      async delete(file: StrapiFile): Promise<void> {
        const key = keyFromFile(file, driver);
        await driver.delete(key);
        logger.debug('deleted', { key, provider: options.provider });
      },

      checkFileSize(file: StrapiFile, { sizeLimit }: { sizeLimit?: number }): void {
        if (typeof sizeLimit === 'number' && file.size != null && file.size > sizeLimit) {
          throw new Error(
            `File "${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)}MB, ` +
              `exceeding the limit of ${(sizeLimit / (1024 * 1024)).toFixed(1)}MB.`,
          );
        }
      },

      async getSignedUrl(file: StrapiFile): Promise<{ url: string }> {
        if (!options.signedUrl.enabled) {
          // Public mode: the stored URL is already the stable public/CDN URL.
          return { url: file.url };
        }
        const key = keyFromFile(file, driver);
        const url = await driver.getSignedUrl(key, options.signedUrl.expiresInSeconds);
        return { url };
      },

      isPrivate(): boolean {
        return options.signedUrl.enabled;
      },
    };
  },
};
