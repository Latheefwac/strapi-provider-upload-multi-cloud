/**
 * Azure Blob Storage driver.
 *
 * Auth, in order of preference:
 *   1. Microsoft Entra ID via `DefaultAzureCredential` (managed identity, env,
 *      workload identity) — no secrets in config.
 *   2. A full connection string.
 *   3. An account name + account key.
 *
 * Signing strategy:
 *   - With an Entra credential (and a known account name) we mint a
 *     **user-delegation SAS** (`getUserDelegationKey`), the recommended,
 *     secret-free approach.
 *   - With a shared key (from `accountKey` or parsed from the connection string)
 *     we mint an account-key SAS.
 *   - With neither, signing throws {@link SigningUnsupportedError} — we never
 *     pretend signing works.
 *
 * Atomic allocation: `If-None-Match: *` on upload fails (409/412) when the blob
 * already exists.
 */

import { Readable } from 'node:stream';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type BlockBlobClient,
  type ContainerClient,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { ObjectExistsError, ProviderError, SigningUnsupportedError } from '../errors';
import type {
  AzureDriverOptions,
  ObjectMetadata,
  PutObjectOptions,
  PutResult,
  StorageDriver,
} from '../types';
import { trimSlashes } from '../util';

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}
function isConflict(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const s = statusOf(err);
  return code === 'BlobAlreadyExists' || code === 'ConditionNotMet' || s === 409 || s === 412;
}
function isNotFound(err: unknown): boolean {
  return (err as { code?: string })?.code === 'BlobNotFound' || statusOf(err) === 404;
}

/** Extract AccountName / AccountKey from an Azure Storage connection string. */
function parseConnectionString(cs: string): { name?: string; key?: string } {
  const parts = Object.fromEntries(
    cs
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf('=');
        return [p.slice(0, idx), p.slice(idx + 1)];
      }),
  );
  return { name: parts.AccountName, key: parts.AccountKey };
}

export class AzureDriver implements StorageDriver {
  public readonly provider = 'azure' as const;
  private readonly service: BlobServiceClient;
  private readonly container: ContainerClient;
  private readonly baseUrl: string;
  private readonly accountName?: string;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private readonly entra?: DefaultAzureCredential;

  constructor(private readonly options: AzureDriverOptions) {
    let accountName = options.accountName;
    let accountKey = options.accountKey;

    if (options.connectionString) {
      const parsed = parseConnectionString(options.connectionString);
      accountName = accountName ?? parsed.name;
      accountKey = accountKey ?? parsed.key;
      this.service = BlobServiceClient.fromConnectionString(options.connectionString);
    } else {
      const serviceUrl =
        options.serviceUrl ?? `https://${accountName}.blob.core.windows.net`;
      if (accountName && accountKey) {
        this.sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
        this.service = new BlobServiceClient(serviceUrl, this.sharedKey);
      } else {
        // Entra / managed identity path.
        this.entra = new DefaultAzureCredential();
        this.service = new BlobServiceClient(serviceUrl, this.entra);
      }
    }

    if (accountName && accountKey && !this.sharedKey) {
      this.sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
    }
    if (!this.sharedKey && !this.entra && accountName) {
      // Connection string without a usable key ⇒ still allow Entra signing.
      this.entra = new DefaultAzureCredential();
    }

    this.accountName = accountName;
    this.container = this.service.getContainerClient(options.containerName);
    this.baseUrl = options.baseUrl
      ? options.baseUrl.replace(/\/+$/, '')
      : `${this.service.url.replace(/\/+$/, '')}/${options.containerName}`;
  }

  private blob(key: string): BlockBlobClient {
    return this.container.getBlockBlobClient(key);
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private headers(opts?: PutObjectOptions) {
    return {
      blobHTTPHeaders: {
        ...(opts?.contentType ? { blobContentType: opts.contentType } : {}),
        ...(opts?.cacheControl ? { blobCacheControl: opts.cacheControl } : {}),
      },
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    };
  }

  async uploadBuffer(key: string, body: Buffer, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      const res = await this.blob(key).uploadData(body, this.headers(opts));
      return { etag: res.etag?.replace(/"/g, '') };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `Azure upload failed for "${key}".`, err);
    }
  }

  async uploadStream(key: string, body: Readable, opts?: PutObjectOptions): Promise<PutResult> {
    try {
      // 4 MiB blocks, up to 5 concurrent — streams without buffering the whole blob.
      const res = await this.blob(key).uploadStream(body, 4 * 1024 * 1024, 5, this.headers(opts));
      return { etag: res.etag?.replace(/"/g, '') };
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `Azure stream upload failed for "${key}".`, err);
    }
  }

  async uploadIfAbsent(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<PutResult> {
    const conditions = { conditions: { ifNoneMatch: '*' } };
    try {
      if (Buffer.isBuffer(body)) {
        const res = await this.blob(key).uploadData(body, { ...this.headers(opts), ...conditions });
        return { etag: res.etag?.replace(/"/g, '') };
      }
      const res = await this.blob(key).uploadStream(body, 4 * 1024 * 1024, 5, {
        ...this.headers(opts),
        ...conditions,
      });
      return { etag: res.etag?.replace(/"/g, '') };
    } catch (err) {
      if (isConflict(err)) throw new ObjectExistsError(key, err);
      throw new ProviderError('UPLOAD_FAILED', `Azure conditional upload failed for "${key}".`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.blob(key).exists();
    } catch (err) {
      throw new ProviderError('UPLOAD_FAILED', `Azure exists failed for "${key}".`, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.blob(key).deleteIfExists({ deleteSnapshots: 'include' });
    } catch (err) {
      throw new ProviderError('DELETE_FAILED', `Azure delete failed for "${key}".`, err);
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    try {
      // Server-side copy needs an authorized source URL; mint a short SAS for it.
      const sourceUrl = await this.getSignedUrl(sourceKey, 600);
      const poller = await this.blob(destKey).beginCopyFromURL(sourceUrl);
      await poller.pollUntilDone();
    } catch (err) {
      throw new ProviderError('COPY_FAILED', `Azure copy failed "${sourceKey}" → "${destKey}".`, err);
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    try {
      const props = await this.blob(key).getProperties();
      return {
        size: props.contentLength,
        contentType: props.contentType,
        etag: props.etag?.replace(/"/g, ''),
        lastModified: props.lastModified,
        metadata: props.metadata,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new ProviderError('UPLOAD_FAILED', `Azure metadata failed for "${key}".`, err);
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const blob = this.blob(key);
    const startsOn = new Date(Date.now() - 60 * 1000); // small clock-skew allowance
    const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
    const permissions = BlobSASPermissions.parse('r');

    try {
      if (this.sharedKey) {
        const sas = generateBlobSASQueryParameters(
          {
            containerName: this.options.containerName,
            blobName: key,
            permissions,
            startsOn,
            expiresOn,
            protocol: SASProtocol.Https,
          },
          this.sharedKey,
        ).toString();
        return `${blob.url}?${sas}`;
      }

      if (this.entra && this.accountName) {
        const udk = await this.service.getUserDelegationKey(startsOn, expiresOn);
        const sas = generateBlobSASQueryParameters(
          {
            containerName: this.options.containerName,
            blobName: key,
            permissions,
            startsOn,
            expiresOn,
            protocol: SASProtocol.Https,
          },
          udk,
          this.accountName,
        ).toString();
        return `${blob.url}?${sas}`;
      }

      throw new SigningUnsupportedError(
        'Azure signing requires an account key, a connection string with a key, or an Entra ' +
          'credential with a known account name (for user-delegation SAS). None was available.',
      );
    } catch (err) {
      if (err instanceof SigningUnsupportedError) throw err;
      throw new SigningUnsupportedError(`Azure failed to generate a SAS for "${key}".`, err);
    }
  }

  async canSign(): Promise<boolean> {
    return Boolean(this.sharedKey || (this.entra && this.accountName));
  }

  get rootPath(): string {
    return this.options.rootPath ? trimSlashes(this.options.rootPath) : '';
  }
}
