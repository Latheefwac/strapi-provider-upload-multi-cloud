import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createRequire } from 'node:module';
import type { StrapiFile } from '../types';

// The provider entry uses `module.exports = { init }` (CommonJS). Load the built
// CJS artifact — the exact form Strapi consumes — via createRequire so it works
// from Vitest's ESM runner. (Run `npm run build` before the tests; the npm
// "test" script and pretest handle this automatically.)
const require = createRequire(import.meta.url);
const provider = require('../../dist/index.js') as {
  init(opts: unknown): {
    upload(f: StrapiFile): Promise<void>;
    uploadStream(f: StrapiFile): Promise<void>;
    delete(f: StrapiFile): Promise<void>;
    checkFileSize(f: StrapiFile, o: { sizeLimit?: number }): void;
    getSignedUrl(f: StrapiFile): Promise<{ url: string }>;
    isPrivate(): boolean;
  };
};

const s3Mock = mockClient(S3Client);

function installStatefulMock() {
  const objects = new Map<string, unknown>();
  s3Mock.on(PutObjectCommand).callsFake((input: any) => {
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
      const err: any = new Error('PreconditionFailed');
      err.name = 'PreconditionFailed';
      err.$metadata = { httpStatusCode: 412 };
      throw err;
    }
    objects.set(input.Key, input.Body);
    return { ETag: '"etag"' };
  });
  s3Mock.on(HeadObjectCommand).callsFake((input: any) => {
    if (!objects.has(input.Key)) {
      const err: any = new Error('NotFound');
      err.name = 'NotFound';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    return { ContentLength: 3 };
  });
  s3Mock.on(DeleteObjectCommand).callsFake((input: any) => {
    objects.delete(input.Key);
    return {};
  });
  return objects;
}

const baseS3 = {
  bucket: 'media',
  region: 'us-east-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secretvalue',
  baseUrl: 'https://cdn.example.com',
  rootPath: 'uploads',
};

function file(overrides: Partial<StrapiFile> = {}): StrapiFile {
  return {
    name: 'company logo.png',
    hash: 'company_logo_abc',
    ext: '.png',
    mime: 'image/png',
    size: 3,
    url: '',
    buffer: Buffer.from('abc'),
    ...overrides,
  };
}

beforeEach(() => s3Mock.reset());

describe('provider contract (S3, public mode)', () => {
  it('uploads, stores a stable public URL and records the key', async () => {
    const objects = installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    const f = file();
    await p.upload(f);

    expect(f.url).toBe('https://cdn.example.com/uploads/company-logo.png');
    expect(f.provider_metadata).toMatchObject({
      provider: 's3',
      key: 'uploads/company-logo.png',
      private: false,
    });
    expect(objects.has('uploads/company-logo.png')).toBe(true);
    expect(p.isPrivate()).toBe(false);
  });

  it('getSignedUrl returns the stored public URL unchanged when signing is off', async () => {
    installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    const f = file();
    await p.upload(f);
    expect(await p.getSignedUrl(f)).toEqual({ url: f.url });
  });

  it('increments the key on collision rather than overwriting', async () => {
    installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    const a = file();
    const b = file();
    await p.upload(a);
    await p.upload(b);
    expect(a.url).toBe('https://cdn.example.com/uploads/company-logo.png');
    expect(b.url).toBe('https://cdn.example.com/uploads/company-logo-1.png');
  });

  it('places files under a resolved human folder prefix', async () => {
    installStatefulMock();
    const p = provider.init({
      provider: 's3',
      s3: baseS3,
      folders: { syncWithCloud: true, preserveHierarchy: true },
      folderPrefixResolver: (fp: string) => (fp === '/1/5' ? 'brand/logos' : undefined),
    });
    const f = file({ folderPath: '/1/5' });
    await p.upload(f);
    expect(f.provider_metadata?.key).toBe('uploads/brand/logos/company-logo.png');
  });

  it('uploadStream stores the object', async () => {
    const objects = installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    const f = file({ buffer: undefined, stream: Readable.from([Buffer.from('abc')]) });
    await p.uploadStream(f);
    expect(objects.has('uploads/company-logo.png')).toBe(true);
  });

  it('delete removes the object using the recorded key', async () => {
    const objects = installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    const f = file();
    await p.upload(f);
    await p.delete(f);
    expect(objects.has('uploads/company-logo.png')).toBe(false);
  });

  it('delete recovers the key from the URL when metadata is absent', async () => {
    const objects = installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    objects.set('uploads/legacy file.png', Buffer.from('x'));
    const f = file({
      url: 'https://cdn.example.com/uploads/legacy%20file.png',
      provider_metadata: null,
    });
    await p.delete(f);
    expect(objects.has('uploads/legacy file.png')).toBe(false);
  });

  it('checkFileSize throws past the limit', () => {
    installStatefulMock();
    const p = provider.init({ provider: 's3', s3: baseS3 });
    expect(() => p.checkFileSize(file({ size: 10 }), { sizeLimit: 5 })).toThrow(/exceeding/);
    expect(() => p.checkFileSize(file({ size: 3 }), { sizeLimit: 5 })).not.toThrow();
  });
});

describe('provider contract (S3, signed/private mode)', () => {
  it('is private, appends a hash to the name, and signs on demand', async () => {
    installStatefulMock();
    const p = provider.init({
      provider: 's3',
      s3: baseS3,
      signedUrl: { enabled: true, expiresInSeconds: 600 },
    });
    expect(p.isPrivate()).toBe(true);

    const f = file();
    await p.upload(f);
    // Stored URL stays the stable, unsigned public URL (never an expiring one).
    expect(f.url).toMatch(/^https:\/\/cdn\.example\.com\/uploads\/company-logo-[0-9a-f]{8}\.png$/);
    expect(f.url).not.toContain('X-Amz-Signature');

    const signed = await p.getSignedUrl(f);
    expect(signed.url).toContain('X-Amz-Signature=');
    expect(signed.url).toContain('X-Amz-Expires=600');
  });
});
