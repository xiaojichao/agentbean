import { describe, expect, test } from 'vitest';
import { formatListDirectoryError, joinDirectoryPath, isRootAnchor } from '../lib/directory-tree';

// 切片1 的 web 端纯函数：错误码翻译 + 路径拼接。
// 树形 UI 组件（切片4）会消费这些纯函数；此处只测可单测的逻辑（沿用 web-next 测 lib 不测组件的惯例）。
describe('formatListDirectoryError', () => {
  test('DEVICE_OFFLINE → 设备不在线提示', () => {
    expect(formatListDirectoryError('DEVICE_OFFLINE')).toContain('不在线');
  });

  test('DIRECTORY_LIST_TIMEOUT → 超时提示', () => {
    expect(formatListDirectoryError('DIRECTORY_LIST_TIMEOUT')).toContain('超时');
  });

  test('PATH_NOT_FOUND → 路径不存在提示', () => {
    expect(formatListDirectoryError('PATH_NOT_FOUND')).toContain('不存在');
  });

  test('PERMISSION_DENIED → 权限提示', () => {
    expect(formatListDirectoryError('PERMISSION_DENIED')).toContain('权限');
  });

  test('未知错误码原样返回（不误吞，供排查）', () => {
    expect(formatListDirectoryError('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  test('空错误码兜底', () => {
    expect(formatListDirectoryError(undefined)).toContain('失败');
  });
});

describe('joinDirectoryPath', () => {
  test('Unix 绝对路径拼接子目录', () => {
    expect(joinDirectoryPath('/Users/shaw', 'projects')).toBe('/Users/shaw/projects');
  });

  test('根路径拼接不带重复斜杠', () => {
    expect(joinDirectoryPath('/', 'Users')).toBe('/Users');
  });

  test('homePath 锚点原样返回（首层不拼）', () => {
    expect(joinDirectoryPath('/Users/shaw', '')).toBe('/Users/shaw');
  });
});

describe('isRootAnchor', () => {
  test('空串是根锚点（首次请求 $HOME）', () => {
    expect(isRootAnchor('')).toBe(true);
  });

  test('~ 是根锚点', () => {
    expect(isRootAnchor('~')).toBe(true);
  });

  test('绝对路径不是根锚点', () => {
    expect(isRootAnchor('/Users/shaw')).toBe(false);
  });
});
