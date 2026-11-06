/**
 * Google Cloud Storage driver.
 *
 * Auth: an inline service-account key or a key file when supplied, otherwise
 * Application Default Credentials / Workload Identity — no key material is
 * required when running with an attached service account.
 *
 * Atomic allocation: the `ifGenerationMatch: 0` precondition means "create only
 * if the object does not exist", which GCS enforces server-side (HTTP 412 on
 * conflict) — a race-safe create primitive.
 *
 * Signing note: V4 signed URLs need a signer. With an inline/key-file service
 * account the library signs locally; with pure ADC it falls back to the IAM
 * `signBlob` API, which requires the `iam.serviceAccounts.signBlob` permission.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage, type Bucket, type SaveOptions, type StorageOptions } from '@google-cloud/storage';
import { ObjectExistsError, ProviderError, SigningUnsupportedError } from '../errors';
import type {
  GcsDriverOptions,
  ObjectMetadata,
  PutObjectOptions,
  PutResult,
  StorageDriver,
} from '../types';
import { trimSlashes } from '../util';

function isPrecondition(err: unknown): boolean {
  const e = err as { code?: number; errors?: Array<{ reason?: string }> };
  return e?.code === 412 || e?.errors?.some((x) => x.reason === 'conditionNotMet') === true;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number })?.code === 404;
}

export class GcsDriver implements StorageDriver {
  public readonly provider = 'gcs' as const;
  private readonly storage: Storage;
  private readonly bucket: Bucket;
  private readonly bucketName: string;
  private readonly baseUrl: string;
  private readonly hasExplicitKey: boolean;

  constructor(private readonly options: GcsDriverOptions) {
    this.bucketName = options.bucket;

    const storageOptions: StorageOptions = {};
    if (options.projectId) storageOptions.projectId = options.projectId;
    if (options.apiEndpoint) storageOptions.apiEndpoint = options.apiEndpoint;
    if (options.keyFilename) storageOptions.keyFilename = options.keyFilename;
    if (options.clientEmail && options.privateKey) {
      storageOptions.credentials = {
        client_email: options.clientEmail,
        private_key: options.privateKey,
      };
    }
    this.hasExplicitKey = Boolean(options.keyFilename || (options.clientEmail && options.privateKey));

    this.storage = new Storage(storageOptions);
    this.bucket = this.storage.bucket(this.bucketName);
    this.baseUrl = options.baseUrl
      ? options.baseUrl.replace(/\/+$/, '')
      : `https://storage.googleapis.com/${this.bucketName}`;
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private objectMetadata(opts?: PutObjectOptions) {
    return {
      ...(opts?.contentType ? { contentType: opts.contentType } : {}),
      ...(opts?.cacheControl ? { cacheControl: opts.cacheControl } : {}),
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    };
  }

  /**
   * Predefined ACL for a save/create. Applied only when `options.predefinedAcl`
   * is configured (e.g. "publicRead") AND the object is public — never on
   * private objects or encryption keys. When unset, no ACL is sent, which keeps
   * the driver compatible with Uniform Bucket-Level Access buckets (object ACLs
   * rejected; public access granted by an IAM policy instead).
   */
  private aclOption(opts?: PutObjectOptions): { predefinedAcl?: SaveOptions['predefinedAcl'] } {
    if (this.options.predefinedAcl && !opts?.isPrivate) {
      return { predefinedAcl: this.options.predefinedAcl as SaveOptions['predefinedAcl'] };
    }
    return {};
  }

  async uploadBuffer(key: string, body: Buffer, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      const file = this.bucket.file(key);
      await file.save(body, { resumable: false, metadata: this.objectMetadata(opts), ...this.aclOption(opts) });
      const [meta] = await file.getMetadata();
      return { etag: meta.etag };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `GCS upload failed for "${key}".`, err);
    }
  }

  async uploadStream(key: string, body: Readable, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      const file = this.bucket.file(key);
      const ws = file.createWriteStream({ resumable: true, metadata: this.objectMetadata(opts), ...this.aclOption(opts) });
      await pipeline(body, ws);
      const [meta] = await file.getMetadata();
      return { etag: meta.etag };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `GCS stream upload failed for "${key}".`, err);
    }
  }

  async uploadIfAbsent(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<PutResult> {
    const file = this.bucket.file(key);
    const metadata = this.objectMetadata(opts);
    try {
      if (Buffer.isBuffer(body)) {
        await file.save(body, {
          resumable: false,
          metadata,
          ...this.aclOption(opts),
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } else {
        const ws = file.createWriteStream({
          resumable: true,
          metadata,
          ...this.aclOption(opts),
          preconditionOpts: { ifGenerationMatch: 0 },
        });
        await pipeline(body, ws);
      }
      return {};
    } catch (err) {
      if (isPrecondition(err)) throw new ObjectExistsError(key, err);
      throw new ProviderError('UPLOAD_FAILED', `GCS conditional upload failed for "${key}".`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const [exists] = await this.bucket.file(key).exists();
      return exists;
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `GCS exists failed for "${key}".`, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      throw new ProviderError('DELETE_FAILED', `GCS delete failed for "${key}".`, err);
    }
  }

  async copyObject(sourceKey: string, destKey: string, opts?: PutObjectOptions): Promise<void> {
    try {
      const dest = this.bucket.file(destKey);
      await this.bucket.file(sourceKey).copy(dest, { ...this.aclOption(opts) });
      if (opts?.contentType || opts?.cacheControl || opts?.metadata) {
        await dest.setMetadata(this.objectMetadata(opts));
      }
    } catch (err) {
      throw new ProviderError('COPY_FAILED', `GCS copy failed "${sourceKey}" → "${destKey}".`, err);
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    try {
      const [meta] = await this.bucket.file(key).getMetadata();
      return {
        size: meta.size ? Number(meta.size) : undefined,
        contentType: meta.contentType,
        etag: meta.etag,
        lastModified: meta.updated ? new Date(meta.updated) : undefined,
        metadata: (meta.metadata as Record<string, string>) ?? undefined,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new ProviderError('UPLOAD_FAILED', `GCS metadata failed for "${key}".`, err);
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    try {
      const [url] = await this.bucket.file(key).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInSeconds * 1000,
      });
      return url;
    } catch (err) {
      throw new SigningUnsupportedError(
        `GCS could not sign a URL for "${key}". With Application Default Credentials the service ` +
          'account needs the "iam.serviceAccounts.signBlob" permission, or configure clientEmail/privateKey.',
        err,
      );
    }
  }

  async canSign(): Promise<boolean> {
    // An explicit key always signs locally. ADC *may* sign via IAM signBlob;
    // we optimistically allow it and surface a clear error at call time if not.
    return true;
  }

  get rootPath(): string {
    return this.options.rootPath ? trimSlashes(this.options.rootPath) : '';
  }

  /** Whether signing uses a locally-held key (informational, for diagnostics). */
  get signsLocally(): boolean {
    return this.hasExplicitKey;
  }
}
