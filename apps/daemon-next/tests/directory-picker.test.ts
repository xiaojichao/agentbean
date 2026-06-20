import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { nativeDirectoryPickerCommands, selectNativeDirectory } from '../src/directory-picker';

describe('directory-picker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns osascript on darwin', () => {
    const cmds = nativeDirectoryPickerCommands('darwin');
    expect(cmds[0].command).toBe('osascript');
  });

  it('returns powershell on win32', () => {
    const cmds = nativeDirectoryPickerCommands('win32');
    expect(cmds[0].command).toBe('powershell.exe');
  });

  it('returns zenity/kdialog on linux', () => {
    const cmds = nativeDirectoryPickerCommands('linux');
    expect(cmds.map((c) => c.command)).toEqual(['zenity', 'kdialog']);
  });

  it('selectNativeDirectory returns trimmed stdout on success', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) => cb(null, '  /home/user/project\n', ''));
    const path = await selectNativeDirectory([{ command: 'zenity', args: [] }]);
    expect(path).toBe('/home/user/project');
  });

  it('selectNativeDirectory returns null on cancel (exit code 1)', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) => cb({ code: 1, message: 'cancelled' }, '', ''));
    const path = await selectNativeDirectory([{ command: 'zenity', args: [] }]);
    expect(path).toBeNull();
  });

  it('selectNativeDirectory reports non-cancel picker failures', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) => cb({ code: 1, message: 'cannot open display' }, '', ''));
    await expect(selectNativeDirectory([{ command: 'zenity', args: [] }])).rejects.toMatchObject({
      message: 'cannot open display',
    });
  });

  it('selectNativeDirectory falls through on ENOENT to next command', async () => {
    (execFile as any)
      .mockImplementationOnce((_c, _a, _o, cb) => cb({ code: 'ENOENT' }, '', ''))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '/path\n', ''));
    const path = await selectNativeDirectory([
      { command: 'zenity', args: [] },
      { command: 'kdialog', args: [] },
    ]);
    expect(path).toBe('/path');
  });
});
