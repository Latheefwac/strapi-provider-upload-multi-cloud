import { describe, it, expect } from 'vitest';
import {
  normalizeFilename,
  normalizeStem,
  splitExtension,
  generateHashSuffix,
  candidateFilename,
  buildPrimaryFilename,
  sanitizeRelativePath,
  assertSafeKey,
  composeKey,
} from '../naming';
import { InvalidKeyError } from '../errors';
import type { FileNamingOptions } from '../types';

const naming: FileNamingOptions = {
  replaceSpacesWithHyphens: true,
  appendHashWhenSigned: true,
  hashLength: 8,
  collisionStrategy: 'increment',
};

describe('normalizeFilename', () => {
  it('replaces spaces with hyphens and preserves the extension', () => {
    expect(normalizeFilename('company logo.png', naming)).toBe('company-logo.png');
  });

  it('preserves the original (multi-dot) extension', () => {
    expect(normalizeFilename('my video.final.mp4', naming)).toBe('my-video.final.mp4');
    expect(splitExtension('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
  });

  it('strips control characters', () => {
    expect(normalizeFilename('bad\u0000\u0007name.txt', naming)).toBe('badname.txt');
  });

  it('collapses repeated hyphens and trims edges', () => {
    expect(normalizeStem('  --weird   name-- ', naming)).toBe('weird-name');
  });

  it('keeps unicode letters and digits', () => {
    expect(normalizeFilename('café 2024.jpg', naming)).toBe('café-2024.jpg');
  });

  it('does not hyphenate when disabled but still collapses whitespace', () => {
    const noHyphen = { ...naming, replaceSpacesWithHyphens: false };
    expect(normalizeFilename('company   logo.png', noHyphen)).toBe('company logo.png');
  });

  it('never yields an empty stem', () => {
    expect(normalizeFilename('***.png', naming)).toBe('file.png');
  });
});

describe('generateHashSuffix', () => {
  it('produces a hex string of the requested length', () => {
    expect(generateHashSuffix(8)).toMatch(/^[0-9a-f]{8}$/);
    expect(generateHashSuffix(16)).toHaveLength(16);
  });

  it('is effectively unique across calls (not derived from input)', () => {
    const set = new Set(Array.from({ length: 500 }, () => generateHashSuffix(8)));
    expect(set.size).toBe(500);
  });
});

describe('candidateFilename / buildPrimaryFilename', () => {
  it('increments before the extension', () => {
    expect(candidateFilename('company-logo', '.png', 0)).toBe('company-logo.png');
    expect(candidateFilename('company-logo', '.png', 2)).toBe('company-logo-2.png');
  });

  it('signed mode appends a hash and keeps the extension', () => {
    const r = buildPrimaryFilename('company logo.png', naming, true);
    expect(r.filename).toMatch(/^company-logo-[0-9a-f]{8}\.png$/);
  });

  it('unsigned mode keeps the plain normalized name', () => {
    const r = buildPrimaryFilename('company logo.png', naming, false);
    expect(r.filename).toBe('company-logo.png');
  });
});

describe('sanitizeRelativePath', () => {
  it('normalizes backslashes and nested segments', () => {
    expect(sanitizeRelativePath('1080p\\segment0001.ts')).toBe('1080p/segment0001.ts');
    expect(sanitizeRelativePath('subtitles/en.vtt')).toBe('subtitles/en.vtt');
  });

  it('rejects path traversal', () => {
    expect(() => sanitizeRelativePath('../../etc/passwd')).toThrow(InvalidKeyError);
    expect(() => sanitizeRelativePath('a/../../b.ts')).toThrow(/traversal/);
  });

  it('rejects absolute and drive-letter paths', () => {
    expect(() => sanitizeRelativePath('/etc/passwd')).toThrow(InvalidKeyError);
    expect(() => sanitizeRelativePath('C:/windows/system32')).toThrow(/Drive-letter/);
  });

  it('rejects NUL and control characters', () => {
    expect(() => sanitizeRelativePath('a\u0000b.ts')).toThrow(/NUL/);
    expect(() => sanitizeRelativePath('a\u0001b.ts')).toThrow(/control/);
  });

  it('drops "." segments but keeps the real path', () => {
    expect(sanitizeRelativePath('./a/./b.ts')).toBe('a/b.ts');
  });
});

describe('assertSafeKey / composeKey', () => {
  it('composes root + folder + filename', () => {
    expect(composeKey({ rootPath: 'uploads', folderPath: '1/5', filename: 'a.png' })).toBe(
      'uploads/1/5/a.png',
    );
  });

  it('rejects traversal in a composed key', () => {
    expect(() => assertSafeKey('uploads/../secret')).toThrow(InvalidKeyError);
    expect(() => assertSafeKey('/leading')).toThrow(/start with/);
  });
});
