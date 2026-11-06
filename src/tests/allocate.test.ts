import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { allocateBuffer, allocateStream } from '../allocate';
import { FakeDriver } from './fake-driver';
import { ProviderError } from '../errors';
import type { FileNamingOptions, PutObjectOptions } from '../types';

const putOpts: PutObjectOptions = { contentType: 'image/png' };

function input(driver: FakeDriver, signed: boolean, naming: Partial<FileNamingOptions> = {}) {
  const fileNaming: FileNamingOptions = {
    replaceSpacesWithHyphens: true,
    appendHashWhenSigned: true,
    hashLength: 8,
    collisionStrategy: 'increment',
    ...naming,
  };
  return {
    driver,
    prefix: 'uploads',
    rawFilename: 'company logo.png',
    fileNaming,
    signed,
    putOptions: putOpts,
  };
}

describe('allocateBuffer — unsigned increment', () => {
  it('keeps the plain name for the first upload', async () => {
    const d = new FakeDriver();
    const key = await allocateBuffer(input(d, false), Buffer.from('a'));
    expect(key).toBe('uploads/company-logo.png');
  });

  it('increments on collision without overwriting the existing object', async () => {
    const d = new FakeDriver();
    const k1 = await allocateBuffer(input(d, false), Buffer.from('one'));
    const k2 = await allocateBuffer(input(d, false), Buffer.from('two'));
    const k3 = await allocateBuffer(input(d, false), Buffer.from('three'));
    expect([k1, k2, k3]).toEqual([
      'uploads/company-logo.png',
      'uploads/company-logo-1.png',
      'uploads/company-logo-2.png',
    ]);
    expect(d.store.get('uploads/company-logo.png')!.body.toString()).toBe('one');
  });

  it('throws on collision when strategy is "error"', async () => {
    const d = new FakeDriver();
    await allocateBuffer(input(d, false, { collisionStrategy: 'error' }), Buffer.from('a'));
    await expect(
      allocateBuffer(input(d, false, { collisionStrategy: 'error' }), Buffer.from('b')),
    ).rejects.toMatchObject({ code: 'OBJECT_EXISTS' });
  });
});

describe('allocateBuffer — signed hash mode', () => {
  it('appends a random hash so repeated uploads never collide', async () => {
    const d = new FakeDriver();
    const keys = await Promise.all(
      Array.from({ length: 10 }, () => allocateBuffer(input(d, true), Buffer.from('x'))),
    );
    expect(new Set(keys).size).toBe(10);
    for (const k of keys) expect(k).toMatch(/^uploads\/company-logo-[0-9a-f]{8}\.png$/);
  });
});

describe('allocateBuffer — concurrent duplicate uploads (race safety)', () => {
  it('assigns distinct keys to many concurrent identical filenames, no overwrites', async () => {
    const d = new FakeDriver();
    const N = 25;
    const keys = await Promise.all(
      Array.from({ length: N }, (_, i) => allocateBuffer(input(d, false), Buffer.from(`body-${i}`))),
    );
    // Every allocation got a unique key…
    expect(new Set(keys).size).toBe(N);
    // …and the store holds exactly N distinct objects (nothing clobbered).
    expect(d.store.size).toBe(N);
    // Keys follow the increment pattern.
    expect(keys).toContain('uploads/company-logo.png');
    expect(keys).toContain('uploads/company-logo-1.png');
  });
});

describe('allocateStream — reserve then write', () => {
  it('reserves an atomic key then writes the stream body', async () => {
    const d = new FakeDriver();
    const key = await allocateStream(input(d, false), Readable.from([Buffer.from('streamed')]));
    expect(key).toBe('uploads/company-logo.png');
    expect(d.store.get(key)!.body.toString()).toBe('streamed');
  });

  it('cleans up the reservation when the stream write fails', async () => {
    const d = new FakeDriver();
    d.failStreamOnce = true;
    await expect(
      allocateStream(input(d, false), Readable.from([Buffer.from('nope')])),
    ).rejects.toBeInstanceOf(ProviderError);
    // The reserved (empty) object must not linger.
    expect(d.store.has('uploads/company-logo.png')).toBe(false);
  });

  it('allocates distinct keys for concurrent identical streamed filenames', async () => {
    const d = new FakeDriver();
    const keys = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        allocateStream(input(d, false), Readable.from([Buffer.from(`s${i}`)])),
      ),
    );
    expect(new Set(keys).size).toBe(8);
    expect(d.store.size).toBe(8);
  });
});
