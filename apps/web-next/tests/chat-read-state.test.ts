import { describe, expect, test } from 'vitest';
import {
  deserializeReadIds,
  loadReadIds,
  readKey,
  saveReadIds,
  serializeReadIds,
  type ReadIdStorage,
} from '../lib/chat-read-state';

function makeFakeStorage(): ReadIdStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe('deserializeReadIds', () => {
  test('null 或空字符串返回空集合', () => {
    expect(deserializeReadIds(null).size).toBe(0);
    expect(deserializeReadIds('').size).toBe(0);
  });

  test('合法字符串数组还原为集合', () => {
    const ids = deserializeReadIds(JSON.stringify(['m1', 'm2', 'm3']));
    expect([...ids].sort()).toEqual(['m1', 'm2', 'm3']);
  });

  test('损坏的 JSON 不抛异常,返回空集合', () => {
    expect(deserializeReadIds('{broken').size).toBe(0);
    expect(deserializeReadIds('not json').size).toBe(0);
  });

  test('非数组 JSON 返回空集合', () => {
    expect(deserializeReadIds(JSON.stringify({ a: 1 })).size).toBe(0);
    expect(deserializeReadIds(JSON.stringify('abc')).size).toBe(0);
    expect(deserializeReadIds(JSON.stringify(42)).size).toBe(0);
  });

  test('过滤掉非字符串元素', () => {
    const ids = deserializeReadIds(JSON.stringify(['keep', 123, true, null, 'keep2']));
    expect([...ids].sort()).toEqual(['keep', 'keep2']);
  });
});

describe('serializeReadIds / deserializeReadIds 往返', () => {
  test('序列化后再反序列化保持一致', () => {
    const original = new Set(['a', 'b', 'c']);
    expect(deserializeReadIds(serializeReadIds(original))).toEqual(original);
  });

  test('空集合往返仍为空', () => {
    expect(deserializeReadIds(serializeReadIds(new Set<string>())).size).toBe(0);
  });
});

describe('readKey', () => {
  test('带统一前缀并按网络隔离', () => {
    expect(readKey('public')).toBe('agentbean:chat:done:public');
    expect(readKey('private')).toBe('agentbean:chat:done:private');
    expect(readKey('public')).not.toBe(readKey('private'));
  });
});

describe('loadReadIds / saveReadIds', () => {
  test('save 后 load 能读回(同一存储、同一网络)', () => {
    const storage = makeFakeStorage();
    saveReadIds('public', new Set(['m1', 'm2']), storage);
    expect([...loadReadIds('public', storage)].sort()).toEqual(['m1', 'm2']);
  });

  test('从未写入的网络返回空集合', () => {
    const storage = makeFakeStorage();
    expect(loadReadIds('public', storage).size).toBe(0);
  });

  test('不同网络的已读集合互不干扰', () => {
    const storage = makeFakeStorage();
    saveReadIds('public', new Set(['pub-1']), storage);
    saveReadIds('private', new Set(['priv-1', 'priv-2']), storage);
    expect([...loadReadIds('public', storage)].sort()).toEqual(['pub-1']);
    expect([...loadReadIds('private', storage)].sort()).toEqual(['priv-1', 'priv-2']);
  });
});
