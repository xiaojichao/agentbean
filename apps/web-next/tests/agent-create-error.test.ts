import { describe, expect, test } from 'vitest';
import { formatCreateAgentError } from '../lib/agent-create-error';

// 创建自定义 Agent 失败时，前端不应把晦涩的错误码（如 FORBIDDEN_REMOTE_DEVICE_SETTINGS）
// 原样显示给用户，而要映射成可操作的中文提示。
describe('formatCreateAgentError', () => {
  test('FORBIDDEN_REMOTE_DEVICE_SETTINGS 翻译为本机配置引导，不泄漏错误码', () => {
    const msg = formatCreateAgentError('FORBIDDEN_REMOTE_DEVICE_SETTINGS');
    expect(msg).not.toMatch(/FORBIDDEN_REMOTE_DEVICE_SETTINGS/);
    expect(msg).toMatch(/本机/);
    expect(msg).toMatch(/设备登录/);
  });

  test('DEVICE_OFFLINE 给出设备在线提示', () => {
    expect(formatCreateAgentError('DEVICE_OFFLINE')).toMatch(/在线/);
  });

  test('FORBIDDEN 给出权限提示', () => {
    expect(formatCreateAgentError('FORBIDDEN')).toMatch(/权限|拥有者|管理员/);
  });

  test('undefined 回退通用「创建失败」', () => {
    expect(formatCreateAgentError(undefined)).toMatch(/创建失败/);
  });

  test('未知短错误码原样展示，供排查（不误吞）', () => {
    expect(formatCreateAgentError('SOME_NEW_CODE')).toBe('SOME_NEW_CODE');
  });
});
