import { describe, it, expect, beforeEach, vi } from 'vitest';

const azState = vi.hoisted(() => ({ objects: new Map<string, { ct?: string }>() }));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
}));

vi.mock('@azure/storage-blob', () => {
  class FakeBlockBlob {
    public url: string;
    constructor(public name: string, containerUrl: string) {
      this.url = `${containerUrl}/${name}`;
    }
    async uploadData(_body: unknown, opts: any) {
      if (opts?.conditions?.ifNoneMatch === '*' && azState.objects.has(this.name)) {
        const e: any = new Error('BlobAlreadyExists');
        e.code = 'BlobAlreadyExists';
        e.statusCode = 409;
        throw e;
      }
      azState.objects.set(this.name, { ct: opts?.blobHTTPHeaders?.blobContentType });
      return { etag: '"az"' };
    }
    async uploadStream(_s: unknown, _bs: number, _mc: number, opts: any) {
      if (opts?.conditions?.ifNoneMatch === '*' && azState.objects.has(this.name)) {
        const e: any = new Error('BlobAlreadyExists');
        e.code = 'BlobAlreadyExists';
        e.statusCode = 409;
        throw e;
      }
      azState.objects.set(this.name, { ct: opts?.blobHTTPHeaders?.blobContentType });
      return { etag: '"az"' };
    }
    async exists() {
      return azState.objects.has(this.name);
    }
    async deleteIfExists() {
      azState.objects.delete(this.name);
      return { succeeded: true };
    }
    async getProperties() {
      if (!azState.objects.has(this.name)) {
        const e: any = new Error('BlobNotFound');
        e.code = 'BlobNotFound';
        e.statusCode = 404;
        throw e;
      }
      return { contentLength: 3, contentType: azState.objects.get(this.name)!.ct, etag: '"az"' };
    }
    async beginCopyFromURL(_url: string) {
      return { pollUntilDone: async () => ({}) };
    }
  }
  class FakeContainer {
    constructor(public url: string, public name: string) {}
    getBlockBlobClient(name: string) {
      return new FakeBlockBlob(name, this.url);
    }
  }
  class FakeService {
    public url = 'https://acct.blob.core.windows.net';
    getContainerClient(name: string) {
      return new FakeContainer(`${this.url}/${name}`, name);
    }
    async getUserDelegationKey() {
      return { value: 'udk', signedObjectId: 'x' };
    }
    static fromConnectionString(_cs: string) {
      return new FakeService();
    }
  }
  return {
    BlobServiceClient: FakeService,
    StorageSharedKeyCredential: class {
      constructor(public account: string, public key: string) {}
    },
    generateBlobSASQueryParameters: () => ({ toString: () => 'sv=2023-11-03&sig=azsig' }),
    BlobSASPermissions: { parse: () => ({}) },
    SASProtocol: { Https: 'https' },
  };
});

import { AzureDriver } from '../drivers/azure';
import { ObjectExistsError, SigningUnsupportedError } from '../errors';

beforeEach(() => azState.objects.clear());

describe('AzureDriver — account key', () => {
  const d = () =>
    new AzureDriver({ containerName: 'media', accountName: 'acct', accountKey: 'a2V5' });

  it('uploads and enforces if-none-match', async () => {
    await d().uploadBuffer('uploads/a.png', Buffer.from('abc'), { contentType: 'image/png' });
    expect(azState.objects.has('uploads/a.png')).toBe(true);
    await expect(d().uploadIfAbsent('uploads/a.png', Buffer.from('x'))).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
  });

  it('exists / delete / metadata', async () => {
    const drv = d();
    await drv.uploadBuffer('uploads/a.png', Buffer.from('abc'), { contentType: 'image/png' });
    expect(await drv.exists('uploads/a.png')).toBe(true);
    expect(await drv.getMetadata('uploads/a.png')).toMatchObject({ contentType: 'image/png' });
    expect(await drv.getMetadata('missing')).toBeNull();
    await drv.delete('uploads/a.png');
    expect(await drv.exists('uploads/a.png')).toBe(false);
  });

  it('signs with an account-key SAS', async () => {
    const drv = d();
    expect(await drv.canSign()).toBe(true);
    const url = await drv.getSignedUrl('uploads/a.png', 600);
    expect(url).toContain('sig=azsig');
    expect(url.startsWith('https://acct.blob.core.windows.net/media/uploads/a.png?')).toBe(true);
  });

  it('copyObject resolves via server-side copy', async () => {
    const drv = d();
    await drv.uploadBuffer('uploads/a.png', Buffer.from('abc'));
    await expect(drv.copyObject('uploads/a.png', 'uploads/b.png')).resolves.toBeUndefined();
  });
});

describe('AzureDriver — Entra user-delegation', () => {
  it('signs via getUserDelegationKey when only an account name is set', async () => {
    const drv = new AzureDriver({ containerName: 'media', accountName: 'acct' });
    expect(await drv.canSign()).toBe(true);
    const url = await drv.getSignedUrl('uploads/a.png', 300);
    expect(url).toContain('sig=azsig');
  });
});

describe('AzureDriver — no signing capability', () => {
  it('cannot sign and throws SigningUnsupportedError', async () => {
    const drv = new AzureDriver({
      containerName: 'media',
      serviceUrl: 'https://acct.blob.core.windows.net',
    });
    expect(await drv.canSign()).toBe(false);
    await expect(drv.getSignedUrl('uploads/a.png', 300)).rejects.toBeInstanceOf(
      SigningUnsupportedError,
    );
  });
});
