import { describe, expect, test } from 'vitest';

import {
  resolveAutoPlacement,
  type ResolveAutoPlacementInput,
} from '../src/index.js';

// Phase 4 第二阶段切片2（#647）：auto placement 决策。
// 总设计 §8.1：auto 根据隐私、在线状态选择，且「不会在未授权情况下把 Device-only 上下文迁移到 Server」。
// 决策原则：device 本地优先（隐私默认），server 仅在显式授权（allowServerContext=true）后兜底；
// 两侧都不可用时 fail closed 给明确失败，绝不静默迁移。

function input(overrides: Partial<ResolveAutoPlacementInput> = {}): ResolveAutoPlacementInput {
  return {
    allowServerContext: true,
    deviceAvailable: true,
    serverAvailable: true,
    ...overrides,
  };
}

describe('resolveAutoPlacement 决策矩阵', () => {
  test('device 可用 + 已授权 server → device（本地优先，隐私默认）', () => {
    const result = resolveAutoPlacement(input());
    expect(result).toEqual({ ok: true, placement: 'device', reasonCode: 'device-preferred' });
  });

  test('device 可用 + 未授权 server → device（server 授权不影响 device 优先）', () => {
    const result = resolveAutoPlacement(input({ allowServerContext: false, serverAvailable: false }));
    expect(result).toEqual({ ok: true, placement: 'device', reasonCode: 'device-preferred' });
  });

  test('device 不可用 + 已授权 server 可用 → managed（server 兜底）', () => {
    const result = resolveAutoPlacement(input({ deviceAvailable: false }));
    expect(result).toEqual({ ok: true, placement: 'managed', reasonCode: 'server-fallback-device-unavailable' });
  });

  test('红线：device 不可用 + 未授权 server → fail closed（不静默迁移 Device-only 上下文）', () => {
    const result = resolveAutoPlacement(input({ allowServerContext: false, deviceAvailable: false }));
    expect(result).toEqual({ ok: false, reasonCode: 'unavailable-device-offline-server-disallowed' });
  });

  test('两侧都不可用（已授权但 server 无容量）→ fail closed 明确失败', () => {
    const result = resolveAutoPlacement(input({ deviceAvailable: false, serverAvailable: false }));
    expect(result).toEqual({ ok: false, reasonCode: 'unavailable-no-capacity' });
  });
});

describe('resolveAutoPlacement 安全不变量（参数化）', () => {
  const cases: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ];
  test.each(cases)('allowServerContext=false 时永不选 managed（device=%s, server=%s）', (deviceAvailable, serverAvailable) => {
    const result = resolveAutoPlacement(input({ allowServerContext: false, deviceAvailable, serverAvailable }));
    if (result.ok) {
      expect(result.placement).not.toBe('managed');
    }
  });

  test.each(cases)('server 不可用时永不选 managed（device=%s, server=%s）', (deviceAvailable, _serverAvailable) => {
    const result = resolveAutoPlacement(input({ deviceAvailable, serverAvailable: false }));
    if (result.ok) {
      expect(result.placement).not.toBe('managed');
    }
  });
});
