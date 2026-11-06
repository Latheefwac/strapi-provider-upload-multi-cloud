/**
 * Collision-safe object-key allocation.
 *
 * The only race-safe primitive we rely on is the driver's atomic
 * {@link StorageDriver.uploadIfAbsent}. Allocation therefore *never* does an
 * `exists()`-then-`upload()` check (two concurrent requests would both see
 * "absent" and clobber each other). Instead it attempts a conditional write and
 * reacts to {@link ObjectExistsError}:
 *
 *   - signed + appendHashWhenSigned: retry with a fresh random suffix;
 *   - unsigned + "increment": retry with `name-1`, `name-2`, …;
 *   - unsigned + "error": surface the collision.
 *
 * Streams can't be replayed, so streamed uploads use "reserve then write":
 * atomically reserve the key with a zero-byte object, then overwrite it with the
 * real stream. The reservation is the atomic step, so concurrency is still safe.
 */

import { Readable } from 'node:stream';
import {
  ObjectExistsError,
  ProviderError,
  isObjectExistsError,
} from './errors';
import {
  candidateFilename,
  composeKey,
  generateHashSuffix,
  normalizeFilename,
  splitExtension,
} from './naming';
import type { FileNamingOptions, PutObjectOptions, StorageDriver } from './types';

const EMPTY = Buffer.alloc(0);
const DEFAULT_MAX_ATTEMPTS = 1000;

export interface AllocationInput {
  driver: StorageDriver;
  /** Full key prefix (root + folder), already composed; may be empty. */
  prefix: string;
  rawFilename: string;
  fileNaming: FileNamingOptions;
  signed: boolean;
  putOptions: PutObjectOptions;
  maxAttempts?: number;
}

/** Candidate filename for a given attempt index, honoring the naming mode. */
function filenameForAttempt(
  stem: string,
  ext: string,
  index: number,
  useHash: boolean,
  hashLength: number,
): string {
  if (useHash) return `${stem}-${generateHashSuffix(hashLength)}${ext}`;
  return candidateFilename(stem, ext, index);
}

/** Allocate a key and upload a buffer in one atomic conditional write per attempt. */
export async function allocateBuffer(input: AllocationInput, body: Buffer): Promise<string> {
  const { driver, prefix, fileNaming, signed, putOptions } = input;
  const { stem, ext } = splitExtension(normalizeFilename(input.rawFilename, fileNaming));
  const useHash = signed && fileNaming.appendHashWhenSigned;
  const max = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let index = 0; index <= max; index++) {
    const filename = filenameForAttempt(stem, ext, index, useHash, fileNaming.hashLength);
    const key = composeKey({ folderPath: prefix, filename });
    try {
      await driver.uploadIfAbsent(key, body, putOptions);
      return key;
    } catch (err) {
      if (!isObjectExistsError(err)) throw err;
      if (!useHash && fileNaming.collisionStrategy === 'error') {
        throw new ProviderError(
          'OBJECT_EXISTS',
          `An object already exists at "${key}" and collisionStrategy is "error".`,
          err,
        );
      }
      // else: loop and try the next candidate (fresh hash or incremented index).
    }
  }
  throw new ProviderError(
    'COLLISION_LIMIT',
    `Could not allocate a unique key for "${input.rawFilename}" after ${max} attempts.`,
  );
}

/**
 * Allocate a key and upload a stream using reserve-then-write. Returns the final
 * key. On write failure after reservation the reserved (empty) object is removed
 * so a failed stream never leaves a stray zero-byte object behind.
 */
export async function allocateStream(input: AllocationInput, body: Readable): Promise<string> {
  const { driver, prefix, fileNaming, signed, putOptions } = input;
  const { stem, ext } = splitExtension(normalizeFilename(input.rawFilename, fileNaming));
  const useHash = signed && fileNaming.appendHashWhenSigned;
  const max = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let reservedKey: string | null = null;
  for (let index = 0; index <= max && reservedKey === null; index++) {
    const filename = filenameForAttempt(stem, ext, index, useHash, fileNaming.hashLength);
    const key = composeKey({ folderPath: prefix, filename });
    try {
      await driver.uploadIfAbsent(key, EMPTY, putOptions);
      reservedKey = key;
    } catch (err) {
      if (!isObjectExistsError(err)) throw err;
      if (!useHash && fileNaming.collisionStrategy === 'error') {
        throw new ProviderError(
          'OBJECT_EXISTS',
          `An object already exists at "${key}" and collisionStrategy is "error".`,
          err,
        );
      }
    }
  }

  if (reservedKey === null) {
    throw new ProviderError(
      'COLLISION_LIMIT',
      `Could not allocate a unique key for "${input.rawFilename}" after ${max} attempts.`,
    );
  }

  try {
    await driver.uploadStream(reservedKey, body, putOptions);
    return reservedKey;
  } catch (err) {
    // Clean up the reservation so a failed stream leaves nothing behind.
    await driver.delete(reservedKey).catch(() => undefined);
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('UPLOAD_FAILED', `Stream upload failed for "${reservedKey}".`, err);
  }
}

export { ObjectExistsError };
