/**
 * AWS S3 storage driver.
 *
 * Auth: static credentials when supplied, otherwise the default AWS credential
 * provider chain (environment, SSO, EC2/ECS/EKS IAM roles) — no long-lived keys
 * are required when an IAM role is available.
 *
 * Atomic allocation: `PutObject` with `If-None-Match: *` fails with a 412
 * PreconditionFailed when the key already exists, giving a race-safe
 * "create-if-absent" primitive (supported by S3 since late 2024, and by most
 * S3-compatible stores such as MinIO).
 */

import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type ObjectCannedACL,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as presignGetUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectExistsError, ProviderError } from '../errors';
import type {
  ObjectMetadata,
  PutObjectOptions,
  PutResult,
  S3DriverOptions,
  StorageDriver,
} from '../types';
import { trimSlashes } from '../util';

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'PreconditionFailed' ||
    e?.name === 'PreconditionFailedException' ||
    e?.$metadata?.httpStatusCode === 412 ||
    e?.$metadata?.httpStatusCode === 409
  );
}

/**
 * Turn an AWS SDK error into a concise, actionable string (name, HTTP status,
 * message, plus a hint for the most common misconfigurations). Without this the
 * provider logs only a generic "upload failed" and the real cause — a bad
 * secret, a missing permission, an unreachable endpoint — stays invisible.
 */
function describeS3Error(err: unknown): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name && e.name !== 'Error' ? e.name : undefined;
  const status = e?.$metadata?.httpStatusCode;
  const parts: string[] = [];
  if (name) parts.push(name);
  if (status) parts.push(`HTTP ${status}`);
  if (e?.message && e.message !== name && e.message !== 'UnknownError') parts.push(e.message);
  let detail = parts.join(' — ');

  const text = `${name ?? ''} ${e?.message ?? ''}`;
  if (name === 'SignatureDoesNotMatch') {
    detail += ' [hint: the secret access key does not match the access key ID — check S3_SECRET_ACCESS_KEY (a valid AWS secret is exactly 40 characters)]';
  } else if (name === 'InvalidAccessKeyId') {
    detail += ' [hint: the access key ID is not recognized — check S3_ACCESS_KEY_ID]';
  } else if (name === 'AccessDenied') {
    detail += ' [hint: credentials are valid but lack permission (s3:PutObject/GetObject/DeleteObject) on this bucket]';
  } else if (name === 'NoSuchBucket') {
    detail += ' [hint: the bucket does not exist in this region — check S3_BUCKET / S3_REGION]';
  } else if (name === 'PermanentRedirect' || /the region .* is wrong/i.test(text)) {
    detail += ' [hint: wrong region for this bucket — check S3_REGION]';
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|timed? ?out/i.test(text)) {
    detail += ' [hint: cannot reach the S3 endpoint — check S3_ENDPOINT / network / that the store is running]';
  }
  return detail || 'unknown S3 error';
}

export class S3Driver implements StorageDriver {
  public readonly provider = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly baseUrl: string;

  constructor(private readonly options: S3DriverOptions) {
    this.bucket = options.bucket;

    const clientConfig: S3ClientConfig = {};
    if (options.region) clientConfig.region = options.region;
    if (options.endpoint) clientConfig.endpoint = options.endpoint;
    if (options.forcePathStyle) clientConfig.forcePathStyle = true;
    if (options.accessKeyId && options.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      };
    }
    this.client = new S3Client(clientConfig);
    this.baseUrl = this.computeBaseUrl();
  }

  private computeBaseUrl(): string {
    if (this.options.baseUrl) return this.options.baseUrl.replace(/\/+$/, '');
    if (this.options.endpoint) {
      const ep = this.options.endpoint.replace(/\/+$/, '');
      return this.options.forcePathStyle ? `${ep}/${this.bucket}` : ep;
    }
    const region = this.options.region ?? 'us-east-1';
    return `https://${this.bucket}.s3.${region}.amazonaws.com`;
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private putParams(key: string, opts?: PutObjectOptions) {
    return {
      Bucket: this.bucket,
      Key: key,
      ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
      ...(opts?.cacheControl ? { CacheControl: opts.cacheControl } : {}),
      ...(opts?.metadata ? { Metadata: opts.metadata } : {}),
      ...(typeof opts?.contentLength === 'number' ? { ContentLength: opts.contentLength } : {}),
      ...this.aclParam(opts),
    };
  }

  /**
   * Canned ACL for a put/copy. Applied only when `options.acl` is configured
   * (e.g. "public-read") AND the object is public — never on private objects or
   * encryption keys. When `acl` is unset, no ACL is sent, which keeps the driver
   * compatible with buckets that have "Bucket owner enforced" (ACLs disabled),
   * where public access is granted by a bucket policy instead.
   */
  private aclParam(opts?: PutObjectOptions): { ACL?: ObjectCannedACL } {
    if (this.options.acl && !opts?.isPrivate) {
      return { ACL: this.options.acl as ObjectCannedACL };
    }
    return {};
  }

  async uploadBuffer(key: string, body: Buffer, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({ ...this.putParams(key, opts), Body: body }),
      );
      return { etag: res.ETag?.replace(/"/g, '') };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `S3 upload failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async uploadStream(key: string, body: Readable, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      // lib-storage handles multipart for large/unknown-length streams.
      const uploader = new Upload({
        client: this.client,
        params: { ...this.putParams(key, opts), Body: body },
      });
      const res = await uploader.done();
      const etag = (res as { ETag?: string }).ETag?.replace(/"/g, '');
      return { etag };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `S3 stream upload failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async uploadIfAbsent(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<PutResult> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          ...this.putParams(key, opts),
          Body: body as Buffer,
          IfNoneMatch: '*',
        }),
      );
      return { etag: res.ETag?.replace(/"/g, '') };
    } catch (err) {
      if (isPreconditionFailed(err)) throw new ObjectExistsError(key, err);
      throw new ProviderError('UPLOAD_FAILED', `S3 conditional upload failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw new ProviderError('UPLOAD_FAILED', `S3 head failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // S3 delete is idempotent for missing keys; only real errors surface.
      throw new ProviderError('DELETE_FAILED', `S3 delete failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async copyObject(sourceKey: string, destKey: string, opts?: PutObjectOptions): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destKey,
          CopySource: `${this.bucket}/${sourceKey}`
            .split('/')
            .map(encodeURIComponent)
            .join('/'),
          ...(opts?.contentType ? { ContentType: opts.contentType, MetadataDirective: 'REPLACE' } : {}),
          ...(opts?.cacheControl ? { CacheControl: opts.cacheControl } : {}),
          ...(opts?.metadata ? { Metadata: opts.metadata } : {}),
          ...this.aclParam(opts),
        }),
      );
    } catch (err) {
      throw new ProviderError('COPY_FAILED', `S3 copy failed "${sourceKey}" → "${destKey}": ${describeS3Error(err)}`, err);
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: res.ContentLength,
        contentType: res.ContentType,
        etag: res.ETag?.replace(/"/g, ''),
        lastModified: res.LastModified,
        metadata: res.Metadata,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new ProviderError('UPLOAD_FAILED', `S3 metadata failed for "${key}": ${describeS3Error(err)}`, err);
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return presignGetUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async canSign(): Promise<boolean> {
    // The presigner signs with whatever credentials the client resolves; any
    // valid chain (static or role) can produce a presigned GET.
    return true;
  }

  /** Expose the configured root prefix so the provider can strip it from keys. */
  get rootPath(): string {
    return this.options.rootPath ? trimSlashes(this.options.rootPath) : '';
  }
}
