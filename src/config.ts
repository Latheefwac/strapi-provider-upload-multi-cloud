/**
 * Provider configuration schema and validation.
 *
 * Strapi passes `providerOptions` straight from `config/plugins.ts`. We validate
 * it at `init()` time with zod and fail fast with an actionable message that
 * names the offending key. Defaults match the task specification. The selected
 * cloud's own options block is required; the other two are optional.
 */

import { z } from 'zod';
import { ConfigError } from './errors';
import type { ProviderOptions } from './types';

const signedUrlSchema = z
  .object({
    enabled: z.boolean().default(false),
    expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).default(900),
  })
  .default({ enabled: false, expiresInSeconds: 900 });

const fileNamingSchema = z
  .object({
    replaceSpacesWithHyphens: z.boolean().default(true),
    appendHashWhenSigned: z.boolean().default(true),
    hashLength: z.number().int().min(4).max(64).default(8),
    collisionStrategy: z.enum(['increment', 'error']).default('increment'),
  })
  .default({
    replaceSpacesWithHyphens: true,
    appendHashWhenSigned: true,
    hashLength: 8,
    collisionStrategy: 'increment',
  });

const foldersSchema = z
  .object({
    syncWithCloud: z.boolean().default(false),
    preserveHierarchy: z.boolean().default(true),
  })
  .default({ syncWithCloud: false, preserveHierarchy: true });

const hlsSchema = z
  .object({
    enabled: z.boolean().default(true),
    preserveRelativePaths: z.boolean().default(true),
    packageHashWhenSigned: z.boolean().default(true),
    maxFiles: z.number().int().positive().default(2000),
    maxFileSizeBytes: z
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024 * 1024), // 2 GiB
    maxTotalBytes: z
      .number()
      .int()
      .positive()
      .default(20 * 1024 * 1024 * 1024), // 20 GiB
    concurrency: z.number().int().min(1).max(64).default(8),
    validatePlaylists: z.boolean().default(true),
  })
  .default({
    enabled: true,
    preserveRelativePaths: true,
    packageHashWhenSigned: true,
    maxFiles: 2000,
    maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024 * 1024,
    concurrency: 8,
    validatePlaylists: true,
  });

const s3Schema = z.object({
  bucket: z.string().min(1),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  rootPath: z.string().optional(),
  acl: z.string().optional(),
});

const gcsSchema = z.object({
  bucket: z.string().min(1),
  projectId: z.string().optional(),
  clientEmail: z.string().optional(),
  privateKey: z.string().optional(),
  keyFilename: z.string().optional(),
  baseUrl: z.string().url().optional(),
  rootPath: z.string().optional(),
  apiEndpoint: z.string().url().optional(),
  predefinedAcl: z.string().optional(),
});

const azureSchema = z.object({
  containerName: z.string().min(1),
  accountName: z.string().optional(),
  accountKey: z.string().optional(),
  connectionString: z.string().optional(),
  serviceUrl: z.string().url().optional(),
  baseUrl: z.string().url().optional(),
  rootPath: z.string().optional(),
});

const providerOptionsSchema = z
  .object({
    provider: z.enum(['s3', 'gcs', 'azure']),
    signedUrl: signedUrlSchema,
    fileNaming: fileNamingSchema,
    folders: foldersSchema,
    hls: hlsSchema,
    publicCacheControl: z.string().default('public, max-age=31536000, immutable'),
    privateCacheControl: z.string().default('private, no-store'),
    s3: s3Schema.optional(),
    gcs: gcsSchema.optional(),
    azure: azureSchema.optional(),
    // Function hook wired by the host app; passed through untouched.
    folderPrefixResolver: z.any().optional(),
  })
  .superRefine((cfg, ctx) => {
    // The selected cloud's own options block must be present and valid.
    if (cfg.provider === 's3' && !cfg.s3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['s3'],
        message: 'provider is "s3" but the "s3" options block is missing (bucket is required).',
      });
    }
    if (cfg.provider === 'gcs' && !cfg.gcs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gcs'],
        message: 'provider is "gcs" but the "gcs" options block is missing (bucket is required).',
      });
    }
    if (cfg.provider === 'azure' && !cfg.azure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['azure'],
        message:
          'provider is "azure" but the "azure" options block is missing (containerName is required).',
      });
    }
    // Azure signing needs *some* credential capable of SAS. Managed identity
    // alone can do user-delegation SAS only when accountName is known.
    if (
      cfg.provider === 'azure' &&
      cfg.signedUrl?.enabled &&
      cfg.azure &&
      !cfg.azure.accountKey &&
      !cfg.azure.connectionString &&
      !cfg.azure.accountName
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['azure'],
        message:
          'signedUrl.enabled is true for Azure but no SAS-capable credential is configured: ' +
          'set azure.accountKey, azure.connectionString, or azure.accountName (for Entra user-delegation SAS).',
      });
    }
  });

/**
 * Replace empty-string values with `undefined`.
 *
 * Strapi's `env()` returns `''` for a variable that is defined but empty (e.g.
 * `S3_ENDPOINT=` left in `.env`). An empty string is not a valid URL and is not
 * a meaningful credential, so an emptied-out var should be treated as "not set"
 * rather than failing validation. Applied only to the per-cloud option blocks,
 * where env vars map directly onto optional fields.
 */
function stripEmptyStrings(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = value === '' ? undefined : value;
  }
  return out;
}

function normalizeRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  for (const key of ['s3', 'gcs', 'azure'] as const) {
    const block = r[key];
    if (block && typeof block === 'object') {
      r[key] = stripEmptyStrings(block as Record<string, unknown>);
    }
  }
  return r;
}

/**
 * Validate raw provider options and return the fully-defaulted config.
 * Throws {@link ConfigError} with a message that names every invalid key.
 */
export function validateConfig(raw: unknown): ProviderOptions {
  const result = providerOptionsSchema.safeParse(normalizeRaw(raw) ?? {});
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length ? issue.path.join('.') : '(root)';
        return `  - providerOptions.${path}: ${issue.message}`;
      })
      .join('\n');
    throw new ConfigError(
      `Invalid upload provider configuration (strapi-provider-upload-multi-cloud-storage):\n${details}`,
    );
  }
  return result.data as ProviderOptions;
}
