/**
 * An in-memory {@link StorageDriver} used by the cloud-agnostic unit tests
 * (naming, allocation, provider wiring). It models the one behavior the
 * allocation logic depends on: `uploadIfAbsent` is atomic and rejects with
 * {@link ObjectExistsError} when the key already exists.
 *
 * A synthetic latency is applied so the concurrency tests actually interleave.
 */

import { Readable } from 'node:stream';
import { ObjectExistsError, ProviderError } from '../errors';
import type {
  CloudProvider,
  ObjectMetadata,
  PutObjectOptions,
  PutResult,
  StorageDriver,
} from '../types';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const tick = () => new Promise((r) => setTimeout(r, 1));

export interface FakeObject {
  body: Buffer;
  opts?: PutObjectOptions;
}

export class FakeDriver implements StorageDriver {
  public readonly provider: CloudProvider;
  public readonly store = new Map<string, FakeObject>();
  /** Count of conditional-write attempts, for assertions. */
  public putIfAbsentCalls = 0;
  public failStreamOnce = false;

  constructor(provider: CloudProvider = 's3', private readonly baseUrl = 'https://cdn.test') {
    this.provider = provider;
  }

  async uploadBuffer(key: string, body: Buffer, opts?: PutObjectOptions): Promise<PutResult> {
    this.store.set(key, { body, opts });
    return { etag: `etag-${this.store.size}` };
  }

  async uploadStream(key: string, body: Readable, opts?: PutObjectOptions): Promise<PutResult> {
    if (this.failStreamOnce) {
      this.failStreamOnce = false;
      throw new ProviderError('UPLOAD_FAILED', 'synthetic stream failure');
    }
    const buf = await streamToBuffer(body);
    this.store.set(key, { body: buf, opts });
    return { etag: `etag-${this.store.size}` };
  }

  async uploadIfAbsent(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<PutResult> {
    this.putIfAbsentCalls++;
    // Read the body first (so stream reservation with an empty buffer works),
    // then re-check existence atomically relative to this event-loop turn.
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await tick(); // force interleaving in concurrency tests
    if (this.store.has(key)) throw new ObjectExistsError(key);
    this.store.set(key, { body: buf, opts });
    return { etag: `etag-${this.store.size}` };
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async copyObject(sourceKey: string, destKey: string, opts?: PutObjectOptions): Promise<void> {
    const src = this.store.get(sourceKey);
    if (!src) throw new ProviderError('COPY_FAILED', `missing source ${sourceKey}`);
    this.store.set(destKey, { body: src.body, opts: opts ?? src.opts });
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    const o = this.store.get(key);
    return o ? { size: o.body.length, contentType: o.opts?.contentType } : null;
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return `${this.baseUrl}/${key}?sig=fake&exp=${expiresInSeconds}`;
  }

  async canSign(): Promise<boolean> {
    return true;
  }
}
