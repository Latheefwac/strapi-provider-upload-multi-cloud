import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Writable } from 'node:stream';

const gcsState = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock('@google-cloud/storage', () => {
  class FakeFile {
    constructor(public name: string) {}
    async save(data: Buffer, opts: any) {
      if (opts?.preconditionOpts?.ifGenerationMatch === 0 && gcsState.objects.has(this.name)) {
        const e: any = new Error('conditionNotMet');
        e.code = 412;
        throw e;
      }
      gcsState.objects.set(this.name, Buffer.from(data));
    }
    createWriteStream(opts: any) {
      const self = this;
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
        final(cb) {
          if (opts?.preconditionOpts?.ifGenerationMatch === 0 && gcsState.objects.has(self.name)) {
            const e: any = new Error('conditionNotMet');
            e.code = 412;
            cb(e);
            return;
          }
          gcsState.objects.set(self.name, Buffer.concat(chunks));
          cb();
        },
      });
    }
    async exists() {
      return [gcsState.objects.has(this.name)];
    }
    async delete(_opts: any) {
      gcsState.objects.delete(this.name);
    }
    async copy(dest: FakeFile) {
      const src = gcsState.objects.get(this.name);
      if (!src) {
        const e: any = new Error('nf');
        e.code = 404;
        throw e;
      }
      gcsState.objects.set(dest.name, src);
    }
    async setMetadata(_m: any) {}
    async getMetadata() {
      if (!gcsState.objects.has(this.name)) {
        const e: any = new Error('nf');
        e.code = 404;
        throw e;
      }
      return [
        {
          etag: 'gcs-etag',
          size: String(gcsState.objects.get(this.name)!.length),
          contentType: 'image/png',
          updated: new Date().toISOString(),
        },
      ];
    }
    async getSignedUrl(_opts: any) {
      return [`https://storage.googleapis.com/bucket/${this.name}?sig=gcs`];
    }
  }
  class FakeBucket {
    constructor(public name: string) {}
    file(name: string) {
      return new FakeFile(name);
    }
  }
  class Storage {
    constructor(public opts: any) {}
    bucket(name: string) {
      return new FakeBucket(name);
    }
  }
  return { Storage };
});

import { GcsDriver } from '../drivers/gcs';
import { ObjectExistsError } from '../errors';

function driver() {
  return new GcsDriver({
    bucket: 'bucket',
    projectId: 'p',
    clientEmail: 'svc@p.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n',
  });
}

beforeEach(() => gcsState.objects.clear());

describe('GcsDriver', () => {
  it('uploads a buffer', async () => {
    await driver().uploadBuffer('uploads/a.png', Buffer.from('abc'), { contentType: 'image/png' });
    expect(gcsState.objects.has('uploads/a.png')).toBe(true);
  });

  it('uploadIfAbsent enforces ifGenerationMatch:0 → ObjectExistsError', async () => {
    const d = driver();
    await d.uploadIfAbsent('uploads/a.png', Buffer.from('abc'));
    await expect(d.uploadIfAbsent('uploads/a.png', Buffer.from('xyz'))).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
  });

  it('stream upload with precondition also rejects a duplicate', async () => {
    const d = driver();
    await d.uploadIfAbsent('uploads/s.ts', Buffer.from('seg'));
    await expect(
      d.uploadIfAbsent('uploads/s.ts', Readable.from([Buffer.from('dup')])),
    ).rejects.toBeInstanceOf(ObjectExistsError);
  });

  it('exists / delete / copy / metadata', async () => {
    const d = driver();
    expect(await d.exists('uploads/a.png')).toBe(false);
    await d.uploadBuffer('uploads/a.png', Buffer.from('abc'));
    expect(await d.exists('uploads/a.png')).toBe(true);
    await d.copyObject('uploads/a.png', 'uploads/b.png');
    expect(gcsState.objects.has('uploads/b.png')).toBe(true);
    expect(await d.getMetadata('missing')).toBeNull();
    expect(await d.getMetadata('uploads/a.png')).toMatchObject({ contentType: 'image/png' });
    await d.delete('uploads/a.png');
    expect(await d.exists('uploads/a.png')).toBe(false);
  });

  it('public and signed URLs', async () => {
    const d = driver();
    expect(d.getPublicUrl('uploads/a.png')).toBe(
      'https://storage.googleapis.com/bucket/uploads/a.png',
    );
    expect(await d.getSignedUrl('uploads/a.png', 900)).toContain('sig=gcs');
    expect(await d.canSign()).toBe(true);
  });
});
