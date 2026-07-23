import { describe, expect, test } from 'vitest';

import { assessCandidateScopeExpansion, assessScopeExpansion } from '../src/index.js';

describe('Memory scope expansion policy (issue #719 / ADR-0007)', () => {
  describe('assessScopeExpansion', () => {
    const NO = { isExpansion: false, kind: null, reason: '' };

    test('same scope is not expansion', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'team', sourceScopeRef: 't1', targetScopeType: 'team', targetScopeRef: 't1' })).toEqual(NO);
      expect(assessScopeExpansion({ sourceScopeType: 'channel', sourceScopeRef: 'c1', targetScopeType: 'channel', targetScopeRef: 'c1' })).toEqual(NO);
    });

    test('channel → team is channel-to-team expansion', () => {
      const a = assessScopeExpansion({ sourceScopeType: 'channel', sourceScopeRef: 'c1', targetScopeType: 'team', targetScopeRef: 't1' });
      expect(a.isExpansion).toBe(true);
      expect(a.kind).toBe('channel-to-team');
      expect(a.reason.length).toBeGreaterThan(0);
    });

    test('task → team / task → channel is task-to-broader expansion', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'task', sourceScopeRef: 'tk1', targetScopeType: 'team', targetScopeRef: 't1' }).kind).toBe('task-to-broader');
      expect(assessScopeExpansion({ sourceScopeType: 'task', sourceScopeRef: 'tk1', targetScopeType: 'channel', targetScopeRef: 'c1' }).kind).toBe('task-to-broader');
    });

    test('dm → team / dm → channel is dm-to-broader expansion', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'dm', sourceScopeRef: 'dm1', targetScopeType: 'team', targetScopeRef: 't1' }).kind).toBe('dm-to-broader');
      expect(assessScopeExpansion({ sourceScopeType: 'dm', sourceScopeRef: 'dm1', targetScopeType: 'channel', targetScopeRef: 'c1' }).kind).toBe('dm-to-broader');
    });

    test('agent → team is agent-to-broader expansion', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'agent', sourceScopeRef: 'a1', targetScopeType: 'team', targetScopeRef: 't1' }).kind).toBe('agent-to-broader');
    });

    test('user → team is broadening expansion', () => {
      const a = assessScopeExpansion({ sourceScopeType: 'user', sourceScopeRef: 'u1', targetScopeType: 'team', targetScopeRef: 't1' });
      expect(a.isExpansion).toBe(true);
    });

    test('channel A → channel B is cross-channel expansion', () => {
      const a = assessScopeExpansion({ sourceScopeType: 'channel', sourceScopeRef: 'c1', targetScopeType: 'channel', targetScopeRef: 'c2' });
      expect(a.isExpansion).toBe(true);
      expect(a.kind).toBe('cross-channel');
    });

    test('agent A → agent B is to-other-agent expansion', () => {
      const a = assessScopeExpansion({ sourceScopeType: 'agent', sourceScopeRef: 'a1', targetScopeType: 'agent', targetScopeRef: 'a2' });
      expect(a.isExpansion).toBe(true);
      expect(a.kind).toBe('to-other-agent');
    });

    test('narrowing (team → channel) is NOT expansion', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'team', sourceScopeRef: 't1', targetScopeType: 'channel', targetScopeRef: 'c1' })).toEqual(NO);
    });

    test('same-width different-type (agent → channel) is NOT gated in MVP', () => {
      expect(assessScopeExpansion({ sourceScopeType: 'agent', sourceScopeRef: 'a1', targetScopeType: 'channel', targetScopeRef: 'c1' })).toEqual(NO);
    });
  });

  describe('assessCandidateScopeExpansion', () => {
    const NO = { isExpansion: false, kind: null, reason: '' };
    const src = (sourceScopeType: 'channel' | 'task' | 'team', sourceScopeRef: string) => ({ sourceScopeType, sourceScopeRef });

    test('no sources is not expansion', () => {
      expect(assessCandidateScopeExpansion({ sources: [], targetScopeType: 'team', targetScopeRef: 't1' })).toEqual(NO);
    });

    test('source already in target scope is not expansion', () => {
      expect(assessCandidateScopeExpansion({
        sources: [src('team', 't1')],
        targetScopeType: 'team', targetScopeRef: 't1',
      })).toEqual(NO);
    });

    test('a single broadening source is expansion', () => {
      const a = assessCandidateScopeExpansion({
        sources: [src('channel', 'c1')],
        targetScopeType: 'team', targetScopeRef: 't1',
      });
      expect(a.isExpansion).toBe(true);
      expect(a.kind).toBe('channel-to-team');
    });

    test('any expanding source among many triggers expansion', () => {
      const a = assessCandidateScopeExpansion({
        sources: [src('team', 't1'), src('channel', 'c1')],
        targetScopeType: 'team', targetScopeRef: 't1',
      });
      expect(a.isExpansion).toBe(true);
    });

    test('all sources within scope is not expansion', () => {
      expect(assessCandidateScopeExpansion({
        sources: [src('channel', 'c1')],
        targetScopeType: 'channel', targetScopeRef: 'c1',
      })).toEqual(NO);
    });
  });
});
