/**
 * Shared types for the multi-cloud upload provider.
 *
 * These describe three things:
 *   1. The Strapi file object as the provider actually receives it.
 *   2. The validated provider options (see {@link ./config}).
 *   3. The internal {@link StorageDriver} abstraction every cloud implements.
 */

import type { Readable } from 'node:stream';

/* -------------------------------------------------------------------------- */
/* Strapi file object                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The file object Strapi hands to a provider's upload/delete/sign methods.
 *
 * Strapi sets `hash` (filename base + random suffix), `ext`, `mime`, `name`,
 * `size`, and the media-library folder path. The provider mutates `url`
 * (and may set `provider_metadata`). Only `buffer` **or** `stream` is present
 * depending on whether `upload()` or `uploadStream()` was called.
 */
export interface StrapiFile {
  name: string;
  hash: string;
  ext?: string;
  mime: string;
  size: number;
  url: string;
  /** Present for buffered uploads. */
  buffer?: Buffer;
  /** Present for streamed uploads. */
  stream?: Readable;
  /**
   * Media-library folder path assigned by Strapi, e.g. "/1/5". Used as a key
   * prefix when `folders.preserveHierarchy` is enabled.
   */
  path?: string;
  folderPath?: string;
  /** Provider-written metadata persisted by Strapi (we store the object key). */
  provider_metadata?: Record<string, unknown> | null;
}

/* -------------------------------------------------------------------------- */
/* Provider options                                                            */
/* -------------------------------------------------------------------------- */

export type CloudProvider = 's3' | 'gcs' | 'azure';
export type CollisionStrategy = 'increment' | 'error';

export interface SignedUrlOptions {
  enabled: boolean;
  expiresInSeconds: number;
}

export interface FileNamingOptions {
  replaceSpacesWithHyphens: boolean;
  appendHashWhenSigned: boolean;
  hashLength: number;
  collisionStrategy: CollisionStrategy;
}

export interface FolderOptions {
  syncWithCloud: boolean;
  preserveHierarchy: boolean;
}

export interface HlsOptions {
  enabled: boolean;
  preserveRelativePaths: boolean;
  packageHashWhenSigned: boolean;
  maxFiles: number;
  maxFileSizeBytes: number;
  maxTotalBytes: number;
  concurrency: number;
  validatePlaylists: boolean;
}

export interface S3DriverOptions {
  bucket: string;
  region?: string;
  /** Optional static credentials. Omit to use the default credential chain / IAM role. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Custom endpoint (e.g. MinIO, R2). */
  endpoint?: string;
  /** Force path-style addressing (required by most S3-compatible emulators). */
  forcePathStyle?: boolean;
  /**
   * Public/CDN base URL used to build the stored (unsigned) file URL.
   * When omitted it is derived from the bucket/region/endpoint.
   */
  baseUrl?: string;
  /** Key prefix prepended to every object (e.g. "uploads"). */
  rootPath?: string;
  /**
   * Canned ACL applied to PUBLIC objects only (e.g. "public-read"). Omit to set
   * no ACL — the default, required for buckets with "Bucket owner enforced"
   * (ACLs disabled), where public access comes from a bucket policy instead.
   * Never applied to private objects or encryption keys.
   */
  acl?: string;
}

export interface GcsDriverOptions {
  bucket: string;
  projectId?: string;
  /** Optional service-account key. Omit to use Application Default Credentials. */
  clientEmail?: string;
  privateKey?: string;
  /** Explicit path to a key file (alternative to inline clientEmail/privateKey). */
  keyFilename?: string;
  baseUrl?: string;
  rootPath?: string;
  /** API endpoint override (for the fake-gcs-server emulator). */
  apiEndpoint?: string;
  /**
   * Predefined ACL applied to PUBLIC objects only (e.g. "publicRead"). Omit to
   * set none — required for buckets with Uniform Bucket-Level Access, where
   * object ACLs are rejected and public access comes from an IAM policy instead.
   * Never applied to private objects or encryption keys.
   */
  predefinedAcl?: string;
}

export interface AzureDriverOptions {
  containerName: string;
  /** Storage account name (required for identity/user-delegation auth). */
  accountName?: string;
  /** Account key — enables account-key SAS. Prefer identity in production. */
  accountKey?: string;
  /** Full connection string — alternative to accountName/accountKey. */
  connectionString?: string;
  /** Explicit service endpoint (for the Azurite emulator). */
  serviceUrl?: string;
  baseUrl?: string;
  rootPath?: string;
}

/** Fully-validated provider options as consumed internally. */
export interface ProviderOptions {
  provider: CloudProvider;
  signedUrl: SignedUrlOptions;
  fileNaming: FileNamingOptions;
  folders: FolderOptions;
  hls: HlsOptions;
  /** Default Cache-Control for public objects. */
  publicCacheControl: string;
  /** Cache-Control forced on private objects and encryption keys. */
  privateCacheControl: string;
  s3?: S3DriverOptions;
  gcs?: GcsDriverOptions;
  azure?: AzureDriverOptions;
  /**
   * Optional hook, wired by the host app, that maps a Strapi media-library
   * folder path (e.g. "/1/5") to a human-readable cloud prefix. When absent,
   * the provider falls back to the numeric folder path. Keeps the provider and
   * the folder-sync plugin decoupled.
   */
  folderPrefixResolver?: (folderPath: string) => string | undefined | Promise<string | undefined>;
}

/* -------------------------------------------------------------------------- */
/* Storage driver abstraction                                                  */
/* -------------------------------------------------------------------------- */

export interface PutObjectOptions {
  contentType?: string;
  cacheControl?: string;
  /** Mark the object private (no public ACL). */
  isPrivate?: boolean;
  /** Arbitrary object metadata where the backend supports it. */
  metadata?: Record<string, string>;
  /**
   * Known body length in bytes. Lets S3 stream a known-size body without
   * buffering it to compute Content-Length. Ignored by backends that chunk.
   */
  contentLength?: number;
}

export interface ObjectMetadata {
  size?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface PutResult {
  etag?: string;
}

/**
 * The common storage contract every cloud driver implements. It is deliberately
 * key-centric (not file-centric): callers compute keys with {@link ./naming}
 * and the driver only moves bytes.
 */
export interface StorageDriver {
  readonly provider: CloudProvider;

  /** Upload a buffer to `key`, overwriting if present. */
  uploadBuffer(key: string, body: Buffer, opts?: PutObjectOptions): Promise<PutResult>;

  /** Upload a stream to `key`, overwriting if present. Streams large bodies. */
  uploadStream(key: string, body: Readable, opts?: PutObjectOptions): Promise<PutResult>;

  /**
   * Atomically upload only if `key` does not already exist.
   * Rejects with {@link ObjectExistsError} when the object is present.
   * This is the primitive that makes collision handling race-safe.
   */
  uploadIfAbsent(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<PutResult>;

  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;

  /** Delete the object at `key`. Must not throw when the object is absent. */
  delete(key: string): Promise<void>;

  /** Server-side copy from `sourceKey` to `destKey`. */
  copyObject(sourceKey: string, destKey: string, opts?: PutObjectOptions): Promise<void>;

  /** Fetch object metadata, or `null` when absent. */
  getMetadata(key: string): Promise<ObjectMetadata | null>;

  /** Stable public/CDN URL for `key` (used when signing is disabled). */
  getPublicUrl(key: string): string;

  /** Time-limited signed read URL for `key`. */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;

  /** True when this driver can mint signed URLs with the configured credentials. */
  canSign(): Promise<boolean>;
}
