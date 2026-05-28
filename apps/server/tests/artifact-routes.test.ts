import { describe, expect, it, vi } from 'vitest';
import { moveUploadedFile } from '../src/artifact-routes.js';

describe('moveUploadedFile', () => {
  it('falls back to copy and unlink when rename crosses filesystems', () => {
    const ops = {
      renameSync: vi.fn(() => {
        const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }),
      copyFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    moveUploadedFile('/tmp/upload-file', '/data/artifact-file', ops);

    expect(ops.renameSync).toHaveBeenCalledWith('/tmp/upload-file', '/data/artifact-file');
    expect(ops.copyFileSync).toHaveBeenCalledWith('/tmp/upload-file', '/data/artifact-file');
    expect(ops.unlinkSync).toHaveBeenCalledWith('/tmp/upload-file');
  });

  it('rethrows non-cross-filesystem rename failures', () => {
    const ops = {
      renameSync: vi.fn(() => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }),
      copyFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    expect(() => moveUploadedFile('/tmp/upload-file', '/data/artifact-file', ops)).toThrow('permission denied');
    expect(ops.copyFileSync).not.toHaveBeenCalled();
    expect(ops.unlinkSync).not.toHaveBeenCalled();
  });
});
