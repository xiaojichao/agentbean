import { describe, expect, test } from 'vitest';

import {
  canManageSystemKnowledge,
  canManageUserMemory,
  canReadSystemKnowledge,
  canReadUserMemory,
} from '../src/index.js';

describe('System/User Memory policy (issue #717)', () => {
  describe('canManageSystemKnowledge (AC#1)', () => {
    test('only system admin can manage', () => {
      expect(canManageSystemKnowledge('admin')).toBe(true);
    });

    test('plain user, unknown role and missing role are denied (fail-closed)', () => {
      expect(canManageSystemKnowledge('user')).toBe(false);
      expect(canManageSystemKnowledge(null)).toBe(false);
      expect(canManageSystemKnowledge(undefined)).toBe(false);
    });
  });

  describe('canReadSystemKnowledge', () => {
    test('system admin can read; others cannot', () => {
      expect(canReadSystemKnowledge('admin')).toBe(true);
      expect(canReadSystemKnowledge('user')).toBe(false);
      expect(canReadSystemKnowledge(null)).toBe(false);
    });
  });

  describe('canManageUserMemory (AC#3/AC#6)', () => {
    test('owner can manage their own User Memory', () => {
      expect(canManageUserMemory('user-1', 'user-1')).toBe(true);
    });

    test('another user cannot manage someone else\'s User Memory', () => {
      expect(canManageUserMemory('user-2', 'user-1')).toBe(false);
    });

    test('system admin is NOT exempt — cannot manage another user\'s User Memory (AC#6)', () => {
      // 关键 fail-closed 断言：admin 身份不打开 User Memory 通路。
      expect(canManageUserMemory('admin-1', 'user-1')).toBe(false);
    });

    test('missing actor or owner is denied (fail-closed)', () => {
      expect(canManageUserMemory(null, 'user-1')).toBe(false);
      expect(canManageUserMemory('user-1', null)).toBe(false);
      expect(canManageUserMemory('', 'user-1')).toBe(false);
      expect(canManageUserMemory('user-1', '')).toBe(false);
      expect(canManageUserMemory(undefined, undefined)).toBe(false);
    });
  });

  describe('canReadUserMemory (AC#6 cross-scope fail-closed)', () => {
    test('owner can read their own; nobody else can, including admin', () => {
      expect(canReadUserMemory('user-1', 'user-1')).toBe(true);
      expect(canReadUserMemory('user-2', 'user-1')).toBe(false);
      // AC#6：跨 scope 读取 fail-closed，admin 也不混入他人个人记忆。
      expect(canReadUserMemory('admin-1', 'user-1')).toBe(false);
    });
  });
});
