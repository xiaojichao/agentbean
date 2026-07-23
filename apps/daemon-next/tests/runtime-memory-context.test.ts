import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DispatchMemoryContextItemDto } from '../../../packages/contracts/src/index.js';
import { createLocalMemoryStore, workspaceMemoryFile } from '../src/memory/local-memory-store.js';
import {
  buildRuntimePrompt,
  prepareDispatchRuntimeMemory,
} from '../src/memory/runtime-memory-context.js';

const serverMemory: DispatchMemoryContextItemDto = {
  schemaVersion: 1,
  id: 'server-1',
  kind: 'decision',
  scopeType: 'task',
  content: 'Use Node 24 for this task.',
  selectionReason: 'invocation-bound-capsule-currently-authorized',
  provenance: {
    origin: 'server', capsuleId: 'capsule-1', authorizationDecisionId: 'decision-1', sourceRefs: [],
  },
};

function request(cwd: string) {
  return {
    id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
    agentId: 'agent-1', requestId: 'request-1', prompt: 'Fix the runtime.',
    customAgent: { adapterKind: 'gemini' as const, command: 'gemini', cwd },
  };
}

describe('Device runtime Memory context', () => {
  test('managed merges Server Capsule first, then current profile/cwd local Memory with deterministic dedupe', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-runtime-memory-'));
    const baseDir = join(cwd, '.home');
    const store = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir, now: () => 100 });
    await store.upsert({
      teamId: 'team-1', cwd, kind: 'decision', scopeType: 'local-workspace', sourceKind: 'manual',
      content: 'Use Node 24 for this task.',
    });
    await store.upsert({
      teamId: 'team-1', cwd, kind: 'procedural', scopeType: 'local-workspace', sourceKind: 'scan',
      dedupeKey: 'build', content: 'Run npm run build:daemon-next.', summary: 'Run daemon matching build.',
    });

    const prepared = await prepareDispatchRuntimeMemory({
      request: { ...request(cwd), managementInvocationId: 'invocation-1', memoryContext: [serverMemory] },
      profileId: 'profile-a', baseDir, now: 200,
    });
    expect(prepared.memoryContext?.map((item) => `${item.provenance.origin}:${item.id}`)).toEqual([
      'server:server-1',
      expect.stringMatching(/^local:/),
    ]);
    expect(prepared.memoryContext?.[1]).toMatchObject({
      content: 'Run daemon matching build.',
      selectionReason: 'current-device-profile-cwd',
      provenance: { origin: 'local', sourceKind: 'scan' },
    });
  });

  test.each(['direct', 'shadow'] as const)('%s path reads local Memory without accepting local entries from Server', async (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), `agentbean-runtime-${mode}-`));
    const baseDir = join(cwd, '.home');
    const store = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir, now: () => 100 });
    await store.upsert({
      teamId: 'team-1', cwd, kind: 'preference', scopeType: 'local-workspace', sourceKind: 'manual',
      content: `${mode} local preference`,
    });
    const untrustedLocal = {
      ...serverMemory,
      id: 'forged-local',
      provenance: { origin: 'local' as const, sourceKind: 'manual' as const },
    };
    const prepared = await prepareDispatchRuntimeMemory({
      request: { ...request(cwd), ...(mode === 'shadow' ? { managementContext: undefined } : {}), memoryContext: [untrustedLocal] },
      profileId: 'profile-a', baseDir, now: 200,
    });
    expect(prepared.memoryContext).toHaveLength(1);
    expect(prepared.memoryContext?.[0]).toMatchObject({ content: `${mode} local preference` });
  });

  test('restart/reconnect reads current persisted Device truth and corrupt state fails closed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-runtime-restart-'));
    const baseDir = join(cwd, '.home');
    const first = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir, now: () => 100 });
    const created = await first.upsert({
      teamId: 'team-1', cwd, kind: 'procedural', scopeType: 'local-workspace', sourceKind: 'scan',
      dedupeKey: 'command', content: 'old command',
    });
    await first.upsert({
      teamId: 'team-1', cwd, kind: 'procedural', scopeType: 'local-workspace', sourceKind: 'scan',
      dedupeKey: 'command', content: 'current command',
    });

    const afterRestart = await prepareDispatchRuntimeMemory({
      request: request(cwd), profileId: 'profile-a', baseDir, now: 200,
    });
    expect(afterRestart.memoryContext?.[0]).toMatchObject({ id: created.item.id, content: 'current command' });

    const file = workspaceMemoryFile(cwd, 'profile-a');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{broken-json');
    const corrupt = await prepareDispatchRuntimeMemory({
      request: { ...request(cwd), memoryContext: [serverMemory] }, profileId: 'profile-a', baseDir, now: 300,
    });
    expect(corrupt.memoryContext).toEqual([serverMemory]);
  });

  test('runtime prompt preserves provenance order and keeps the current input last', () => {
    const local: DispatchMemoryContextItemDto = {
      schemaVersion: 1, id: 'local-1', kind: 'procedural', scopeType: 'local-workspace',
      content: 'Run the matching build.', selectionReason: 'current-device-profile-cwd',
      provenance: { origin: 'local', sourceKind: 'scan' },
    };
    const prompt = buildRuntimePrompt({ prompt: 'Current request wins.', memoryContext: [serverMemory, local] });
    expect(prompt.indexOf('Server 协作记忆')).toBeLessThan(prompt.indexOf('当前 Device 本地记忆'));
    expect(prompt.indexOf('当前 Device 本地记忆')).toBeLessThan(prompt.indexOf('## 当前用户输入'));
    expect(prompt.endsWith('Current request wins.')).toBe(true);
    expect(prompt).not.toContain('/Users/');
  });

  test('#718 server/projection provenance renders as projection:<id> (team-opted-in Agent Memory)', () => {
    const projection: DispatchMemoryContextItemDto = {
      schemaVersion: 1, id: 'proj-1', kind: 'preference', scopeType: 'agent',
      content: 'Agent prefers concise replies.', selectionReason: 'team-opted-in-agent-memory-projection',
      provenance: { origin: 'server', projectionId: 'proj-1', sourceRefs: [] },
    };
    const prompt = buildRuntimePrompt({ prompt: 'Do the task.', memoryContext: [projection] });
    expect(prompt).toContain('projection:proj-1');
    expect(prompt).not.toContain('capsule:proj-1'); // 不误标为 capsule
    expect(prompt).toContain('Agent prefers concise replies.');
  });
});
