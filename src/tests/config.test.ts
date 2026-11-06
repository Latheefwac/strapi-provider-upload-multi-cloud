import { describe, it, expect } from 'vitest';
import { validateConfig } from '../config';
import { ConfigError } from '../errors';

describe('validateConfig', () => {
  it('applies spec defaults', () => {
    const cfg = validateConfig({ provider: 's3', s3: { bucket: 'b', region: 'us-east-1' } });
    expect(cfg.signedUrl).toEqual({ enabled: false, expiresInSeconds: 900 });
    expect(cfg.fileNaming).toEqual({
      replaceSpacesWithHyphens: true,
      appendHashWhenSigned: true,
      hashLength: 8,
      collisionStrategy: 'increment',
    });
    expect(cfg.hls.concurrency).toBe(8);
    expect(cfg.folders.preserveHierarchy).toBe(true);
  });

  it('rejects an invalid provider value', () => {
    expect(() => validateConfig({ provider: 'wasabi' })).toThrow(ConfigError);
  });

  it('requires the selected cloud block', () => {
    expect(() => validateConfig({ provider: 's3' })).toThrow(/s3.*options block is missing/s);
    expect(() => validateConfig({ provider: 'gcs' })).toThrow(/gcs/);
    expect(() => validateConfig({ provider: 'azure' })).toThrow(/azure/);
  });

  it('requires a bucket for s3', () => {
    expect(() => validateConfig({ provider: 's3', s3: {} })).toThrow(/bucket/);
  });

  it('rejects Azure signing without any SAS-capable credential', () => {
    expect(() =>
      validateConfig({
        provider: 'azure',
        signedUrl: { enabled: true, expiresInSeconds: 600 },
        azure: { containerName: 'media' },
      }),
    ).toThrow(/SAS-capable credential/);
  });

  it('accepts Azure signing with an account name (user-delegation path)', () => {
    const cfg = validateConfig({
      provider: 'azure',
      signedUrl: { enabled: true, expiresInSeconds: 600 },
      azure: { containerName: 'media', accountName: 'acct' },
    });
    expect(cfg.signedUrl.enabled).toBe(true);
  });

  it('treats emptied-out cloud env vars as unset (empty string -> undefined)', () => {
    // e.g. `S3_ENDPOINT=` / `S3_BASE_URL=` left blank in .env when switching
    // from MinIO to real AWS: empty strings must not fail URL validation.
    const cfg = validateConfig({
      provider: 's3',
      s3: { bucket: 'b', region: 'eu-central-1', endpoint: '', baseUrl: '', accessKeyId: '' },
    });
    expect(cfg.s3?.endpoint).toBeUndefined();
    expect(cfg.s3?.baseUrl).toBeUndefined();
    expect(cfg.s3?.accessKeyId).toBeUndefined();
    expect(cfg.s3?.bucket).toBe('b');
  });

  it('clamps hashLength and ttl within allowed bounds', () => {
    expect(() =>
      validateConfig({ provider: 's3', s3: { bucket: 'b' }, fileNaming: { hashLength: 2 } }),
    ).toThrow(/hashLength/);
    expect(() =>
      validateConfig({ provider: 's3', s3: { bucket: 'b' }, signedUrl: { expiresInSeconds: -1 } }),
    ).toThrow(/expiresInSeconds/);
  });
});
