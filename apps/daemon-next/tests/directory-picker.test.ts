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

  // 回归：macOS daemon 未在桌面会话运行时，osascript 连不上窗口服务器，
  // 报 com.apple.view-bridge: Connection interrupted（且 AppleScript 仍返回 -128）。
  // 这不是"用户取消"，必须分类为稳定错误码，供前端展示可操作提示。
  it('classifies macOS view-bridge failure as DIRECTORY_PICKER_UNAVAILABLE', async () => {
    const stderr = [
      "2026-06-30 09:40:24.508 osascript[79992:206960038] +[NSXPCSharedListener endpointForReply:withListenerName:replyErrorCode:]: an error occurred while attempting to obtain endpoint for listener 'com.apple.view-bridge': Connection interrupted",
      '15:88: execution error: 用户已取消。 (-128)',
    ].join('\n');
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) =>
      cb({ code: 1, message: `Command failed: osascript -e ...\n${stderr}`, stderr }, '', ''),
    );
    await expect(selectNativeDirectory(nativeDirectoryPickerCommands('darwin'))).rejects.toMatchObject({
      code: 'DIRECTORY_PICKER_UNAVAILABLE',
    });
  });

  // 中文 locale 下用户真实点取消（无 view-bridge 文本）应识别为取消并返回 null，
  // 而不是把原始错误抛给前端。
  it('returns null on localized (zh) user cancel without view-bridge', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) =>
      cb({ code: 1, message: 'execution error: 用户已取消。 (-128)', stderr: '15:88: execution error: 用户已取消。 (-128)' }, '', ''),
    );
    const path = await selectNativeDirectory([{ command: 'osascript', args: [] }]);
    expect(path).toBeNull();
  });
});
