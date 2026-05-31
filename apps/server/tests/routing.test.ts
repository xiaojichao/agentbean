import { describe, expect, it } from 'vitest';
import { routeHumanMessage } from '../src/routing.js';
import type { AgentRuntime } from '../src/registry.js';

const make = (id: string, name: string, status: AgentRuntime['status'] = 'online'): AgentRuntime => ({
  id,
  name,
  role: 'tester',
  adapterKind: 'codex',
  status,
  socketId: 's-' + id,
  firstSeenAt: 0,
  lastHeartbeatAt: 0,
  lastError: null,
});

describe('routeHumanMessage', () => {
  it('returns empty when no online members', () => {
    const result = routeHumanMessage({ body: 'hi', members: [make('a', 'A', 'offline')] });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe('NO_ONLINE');
  });

  it('routes to mentioned agent by exact name', () => {
    const a = make('a', '肖');
    const b = make('b', 'Codex');
    const result = routeHumanMessage({ body: '@Codex 你好', members: [a, b] });
    expect(result.targets.map((m) => m.id)).toEqual(['b']);
    expect(result.reason).toBe('MENTION');
  });

  it('does not route mentioned agents outside the channel members', () => {
    const hermes = make('h', 'Hermes-Agent');
    const result = routeHumanMessage({
      body: '@Hermes-Agent 你好',
      members: [],
    });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe('NO_ONLINE');
  });

  it('falls back to first online member when no mention', () => {
    const a = make('a', '肖');
    const b = make('b', 'Codex');
    const result = routeHumanMessage({ body: '你好啊', members: [a, b] });
    expect(result.targets.map((m) => m.id)).toEqual(['a']);
    expect(result.reason).toBe('FALLBACK');
  });

  it('reports unknown mention without falling back to another agent', () => {
    const a = make('a', '肖');
    const result = routeHumanMessage({ body: '@Nobody 看', members: [a] });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe('UNKNOWN_MENTION');
  });

  it('treats a mentioned human member as human chat without agent dispatch', () => {
    const a = make('a', 'Codex');
    const result = routeHumanMessage({
      body: '@shaw_cd 你好',
      members: [a],
      humans: [{ id: 'u1', name: 'shaw_cd' }],
    });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe('HUMAN_MENTION');
  });
});
