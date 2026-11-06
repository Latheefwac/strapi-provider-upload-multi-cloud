import { describe, it, expect } from 'vitest';
import {
  resolveMimeType,
  extname,
  isEncryptionKey,
  isPlaylist,
  MIME_BY_EXTENSION,
} from '../mime-types';

describe('mime-types', () => {
  it('maps the required HLS extensions', () => {
    expect(MIME_BY_EXTENSION['.m3u8']).toBe('application/vnd.apple.mpegurl');
    expect(MIME_BY_EXTENSION['.m3u']).toBe('audio/mpegurl');
    expect(MIME_BY_EXTENSION['.ts']).toBe('video/mp2t');
    expect(MIME_BY_EXTENSION['.m4s']).toBe('video/iso.segment');
    expect(MIME_BY_EXTENSION['.mp4']).toBe('video/mp4');
    expect(MIME_BY_EXTENSION['.vtt']).toBe('text/vtt');
    expect(MIME_BY_EXTENSION['.key']).toBe('application/octet-stream');
  });

  it('resolves by extension, case-insensitively', () => {
    expect(resolveMimeType('playlist.M3U8')).toBe('application/vnd.apple.mpegurl');
    expect(resolveMimeType('segment0001.ts')).toBe('video/mp2t');
  });

  it('prefers a non-generic fallback mime over octet-stream', () => {
    expect(resolveMimeType('weird.unknownext', 'image/webp')).toBe('image/webp');
    expect(resolveMimeType('weird.unknownext', 'application/octet-stream')).toBe(
      'application/octet-stream',
    );
    expect(resolveMimeType('weird.unknownext')).toBe('application/octet-stream');
  });

  it('extracts extensions from keys and paths', () => {
    expect(extname('a/b/c.VTT')).toBe('.vtt');
    expect(extname('noext')).toBe('');
    expect(extname('.dotfile')).toBe('');
  });

  it('classifies encryption keys and playlists', () => {
    expect(isEncryptionKey('enc.key')).toBe(true);
    expect(isEncryptionKey('video.ts')).toBe(false);
    expect(isPlaylist('master.m3u8')).toBe(true);
    expect(isPlaylist('audio.m3u')).toBe(true);
    expect(isPlaylist('v.ts')).toBe(false);
  });
});
