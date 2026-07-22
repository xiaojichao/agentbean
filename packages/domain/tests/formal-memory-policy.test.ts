import { describe, expect, test } from 'vitest';

import {
  canManageFormalMemory,
  canProposeFormalCorrection,
  canReadFormalMemory,
} from '../src/index.js';

describe('Formal Memory policy (issue #716)', () => {
  describe('canManageFormalMemory (AC#3)', () => {
    test('owner and admin can manage', () => {
      expect(canManageFormalMemory('owner')).toBe(true);
      expect(canManageFormalMemory('admin')).toBe(true);
    });

    test('plain member and non-member cannot manage', () => {
      expect(canManageFormalMemory('member')).toBe(false);
      expect(canManageFormalMemory(null)).toBe(false);
    });
  });

  describe('canProposeFormalCorrection (AC#6)', () => {
    test('any team member can propose a correction', () => {
      expect(canProposeFormalCorrection('owner')).toBe(true);
      expect(canProposeFormalCorrection('admin')).toBe(true);
      expect(canProposeFormalCorrection('member')).toBe(true);
    });

    test('non-member cannot propose', () => {
      expect(canProposeFormalCorrection(null)).toBe(false);
    });
  });

  describe('canReadFormalMemory (AC#5)', () => {
    test('non-member can never read', () => {
      expect(canReadFormalMemory(null, 'team', false)).toBe(false);
      expect(canReadFormalMemory(null, 'channel', true)).toBe(false);
    });

    test('team scope is visible to any team member', () => {
      expect(canReadFormalMemory('member', 'team', false)).toBe(true);
      expect(canReadFormalMemory('owner', 'team', false)).toBe(true);
    });

    test('channel scope requires channel membership for plain members', () => {
      expect(canReadFormalMemory('member', 'channel', true)).toBe(true);
      // plain team member but NOT a member of this specific channel
      expect(canReadFormalMemory('member', 'channel', false)).toBe(false);
    });

    test('owner/admin can read all channels (manage implies read)', () => {
      expect(canReadFormalMemory('admin', 'channel', false)).toBe(true);
      expect(canReadFormalMemory('owner', 'channel', false)).toBe(true);
    });
  });
});
