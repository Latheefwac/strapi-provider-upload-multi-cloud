import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Driver } from '../drivers/s3';
import { ObjectExistsError } from '../errors';

const s3Mock = mockClient(S3Client);

/** A tiny stateful in-memory S3 so conditional writes behave realistically. */
function installStatefulMock() {
  const objects = new Map<string, { body: unknown; contentType?: string }>();

  s3Mock.on(PutObjectCommand).callsFake((input: any) => {
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
      const err: any = new Error('PreconditionFailed');
      err.name = 'PreconditionFailed';
      err.$metadata = { httpStatusCode: 412 };
      throw err;
    }
    objects.set(input.Key, { body: input.Body, contentType: input.ContentType });
    return { ETag: '"put-etag"' };
  });

  s3Mock.on(HeadObjectCommand).callsFake((input: any) => {
    if (!objects.has(input.Key)) {
      const err: any = new Error('NotFound');
      err.name = 'NotFound';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    const o = objects.get(input.Key)!;
    return { ContentLength: 3, ContentType: o.contentType, ETag: '"head-etag"' };
  });

  s3Mock.on(DeleteObjectCommand).callsFake((input: any) => {
    objects.delete(input.Key);
    return {};
  });

  s3Mock.on(CopyObjectCommand).callsFake((input: any) => {
    const src = decodeURIComponent(String(input.CopySource)).replace(/^[^/]+\//, '');
    if (objects.has(src)) objects.set(input.Key, objects.get(src)!);
    return {};
  });

  return objects;
}

function driver() {
  return new S3Driver({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secretvalue',
    baseUrl: 'https://cdn.example.com',
  });
}

beforeEach(() => {
  s3Mock.reset();
});

describe('S3Driver', () => {
  it('uploads a buffer and reports an etag', async () => {
    installStatefulMock();
    const res = await driver().uploadBuffer('uploads/a.png', Buffer.from('abc'), {
      contentType: 'image/png',
    });
    expect(res.etag).toBe('put-etag');
  });

  it('uploadIfAbsent succeeds once then rejects with ObjectExistsError', async () => {
    installStatefulMock();
    const d = driver();
    await d.uploadIfAbsent('uploads/a.png', Buffer.from('abc'));
    await expect(d.uploadIfAbsent('uploads/a.png', Buffer.from('xyz'))).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
  });

  it('exists reflects stored objects and 404s', async () => {
    installStatefulMock();
    const d = driver();
    expect(await d.exists('uploads/a.png')).toBe(false);
    await d.uploadBuffer('uploads/a.png', Buffer.from('abc'));
    expect(await d.exists('uploads/a.png')).toBe(true);
  });

  it('delete is idempotent', async () => {
    installStatefulMock();
    const d = driver();
    await d.uploadBuffer('uploads/a.png', Buffer.from('abc'));
    await d.delete('uploads/a.png');
    await expect(d.delete('uploads/a.png')).resolves.toBeUndefined();
    expect(await d.exists('uploads/a.png')).toBe(false);
  });

  it('copies objects server-side', async () => {
    const objects = installStatefulMock();
    const d = driver();
    await d.uploadBuffer('uploads/old/a.png', Buffer.from('abc'));
    await d.copyObject('uploads/old/a.png', 'uploads/new/a.png');
    expect(objects.has('uploads/new/a.png')).toBe(true);
  });

  it('streams a small body via a single PutObject', async () => {
    const objects = installStatefulMock();
    const d = driver();
    await d.uploadStream('uploads/s.ts', Readable.from([Buffer.from('seg')]), {
      contentType: 'video/mp2t',
    });
    expect(objects.get('uploads/s.ts')?.contentType).toBe('video/mp2t');
  });

  it('builds a public URL and a signed URL', async () => {
    installStatefulMock();
    const d = driver();
    expect(d.getPublicUrl('uploads/a b.png')).toBe('https://cdn.example.com/uploads/a%20b.png');
    const signed = await d.getSignedUrl('uploads/a.png', 900);
    expect(signed).toContain('X-Amz-Signature=');
    expect(signed).toContain('X-Amz-Expires=900');
  });

  it('reads object metadata or null', async () => {
    installStatefulMock();
    const d = driver();
    expect(await d.getMetadata('missing')).toBeNull();
    await d.uploadBuffer('uploads/a.png', Buffer.from('abc'), { contentType: 'image/png' });
    expect(await d.getMetadata('uploads/a.png')).toMatchObject({ contentType: 'image/png' });
  });
});
