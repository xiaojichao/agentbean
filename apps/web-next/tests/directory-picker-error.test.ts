import { describe, expect, test } from 'vitest';
import { directoryPickerErrorMessage } from '../lib/directory-picker-error';

// 目录浏览失败时，前端绝不能把原始 shell 报错（如 osascript 的
// "Command failed: ..." + view-bridge stderr blob）原样泄漏给用户。
// 必须映射成稳定错误码对应的、可操作的中文提示。
describe('directoryPickerErrorMessage', () => {
  test('CANCELLED 不显示任何错误', () => {
    expect(directoryPickerErrorMessage('CANCELLED')).toBe('');
  });

  test('DIRECTORY_PICKER_UNAVAILABLE 给出可操作提示（手动填写 + 桌面会话）', () => {
    const msg = directoryPickerErrorMessage('DIRECTORY_PICKER_UNAVAILABLE');
    expect(msg).toMatch(/手动填写/);
    expect(msg).toMatch(/桌面会话|桌面终端/);
  });

  test('原始 osascript 报错 blob 不原样泄漏，回退通用友好提示', () => {
    const blob = 'Command failed: osascript -e POSIX path of (choose folder ...)\ncom.apple.view-bridge: Connection interrupted\n用户已取消。 (-128)';
    const msg = directoryPickerErrorMessage(blob);
    expect(msg).not.toMatch(/Command failed:/);
    expect(msg).not.toMatch(/osascript/);
    expect(msg.length).toBeGreaterThan(0);
  });

  test('未知短文本错误仍原样展示（供排查），不误吞', () => {
    expect(directoryPickerErrorMessage('something unexpected')).toBe('something unexpected');
  });

  test('undefined 回退通用友好提示', () => {
    expect(directoryPickerErrorMessage(undefined)).toMatch(/无法打开目录浏览/);
  });

  test('timeout / DIRECTORY_PICKER_TIMEOUT 给出桌面会话提示（激活既有友好文案）', () => {
    const msg = directoryPickerErrorMessage('timeout');
    expect(msg).toMatch(/桌面会话/);
    expect(directoryPickerErrorMessage('DIRECTORY_PICKER_TIMEOUT')).toBe(msg);
  });

  test('DEVICE_OFFLINE 保留既有文案（回归）', () => {
    expect(directoryPickerErrorMessage('DEVICE_OFFLINE')).toMatch(/不在线/);
  });
});
