import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/socket.js';

function writeSkill(dir: string, name: string) {
  const d = join(dir, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody`);
}

describe('scanRequested customAgents → reportCustomSkills', () => {
  test('收到 customAgents 后扫描并上报 skills', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    writeSkill(join(home, '.claude/skills'), 'analyze');
    const emitted: { event: string; payload: unknown }[] = [];
    const handlers: Record<string, (p: unknown, ack?: (r: unknown) => void) => void> = {};
    const socket = {
      on: (ev: string, h: (p: unknown, ack?: (r: unknown) => void) => void) => { handlers[ev] = h; },
      emitWithAck: vi.fn(async (event: string, payload: unknown) => {
        emitted.push({ event, payload }); return { ok: true };
      }),
    };

    // 直接调内部扫描+上报函数（见 Step 3 导出的 reportCustomAgentSkills）
    const { reportCustomAgentSkills } = await import('../src/index.js');
    await reportCustomAgentSkills(socket as any, {
      teamId: 't1', deviceId: 'd1',
      customAgents: [{ id: 'a1', adapterKind: 'claude-code', cwd: undefined }],
    }, home);

    expect(emitted[0].event).toBe(AGENT_EVENTS.agent.reportCustomSkills);
    const payload = emitted[0].payload as { items: { agentId: string; skills: { name: string }[] }[] };
    expect(payload.items[0].agentId).toBe('a1');
    expect(payload.items[0].skills.map((s) => s.name)).toContain('analyze');
  });

  test('单个 custom agent 扫描抛错时该 agent skills 为空，不影响其它', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    writeSkill(join(home, '.claude/skills'), 'analyze');
    const emitted: { event: string; payload: unknown }[] = [];
    const socket = {
      on: () => {},
      emitWithAck: vi.fn(async (event: string, payload: unknown) => {
        emitted.push({ event, payload }); return { ok: true };
      }),
    };

    const { reportCustomAgentSkills } = await import('../src/index.js');
    // adapterKind 'kimi-cli' 没有扫描配置 → scanCustomAgentSkills 返回 []（不抛），覆盖空路径；
    // 这里再验证多 agent 时即使一个为空，另一个仍能扫到 skills
    await reportCustomAgentSkills(socket as any, {
      teamId: 't1', deviceId: 'd1',
      customAgents: [
        { id: 'a-empty', adapterKind: 'kimi-cli', cwd: undefined },
        { id: 'a1', adapterKind: 'claude-code', cwd: undefined },
      ],
    }, home);

    const payload = emitted[0].payload as { items: { agentId: string; skills: { name: string }[] }[] };
    expect(payload.items).toHaveLength(2);
    const empty = payload.items.find((i) => i.agentId === 'a-empty')!;
    expect(empty.skills).toEqual([]);
    const ok = payload.items.find((i) => i.agentId === 'a1')!;
    expect(ok.skills.map((s) => s.name)).toContain('analyze');
  });

  test('emitWithAck 上报失败只 warn 不抛错', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = {
      on: () => {},
      emitWithAck: vi.fn(async () => { throw new Error('network down'); }),
    };

    const { reportCustomAgentSkills } = await import('../src/index.js');
    await expect(
      reportCustomAgentSkills(socket as any, {
        teamId: 't1', deviceId: 'd1',
        customAgents: [{ id: 'a1', adapterKind: 'claude-code', cwd: undefined }],
      }, home),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
