import { describe, expect, it, vi } from 'vitest';
import type { DaemonScanSnapshot } from '../src/index';
import { hasChanged, createRescanController } from '../src/rescan';

function snap(runtimes: Array<{ adapterKind: string; name: string; command?: string }> = [], agents: Array<{ name: string; adapterKind: string }> = []): DaemonScanSnapshot {
  return { runtimes, agents };
}

describe('hasChanged', () => {
  it('returns false for identical signatures', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex CLI', command: '/usr/bin/codex' }]);
    expect(hasChanged(a, a)).toBe(false);
  });

  it('returns false when entries differ only by order', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'claude-code', name: 'Claude', command: '/y' }]);
    const b = snap([{ adapterKind: 'claude-code', name: 'Claude', command: '/y' }, { adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    expect(hasChanged(a, b)).toBe(false);
  });

  it('returns true when a command path changes', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/old/codex' }]);
    const b = snap([{ adapterKind: 'codex', name: 'Codex', command: '/new/codex' }]);
    expect(hasChanged(a, b)).toBe(true);
  });

  it('returns true when a runtime is added or removed', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    const b = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }]);
    expect(hasChanged(a, b)).toBe(true);
  });

  it('ignores version field (only adapterKind/name/command matter)', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    const b = { runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x', version: '1.2.3', installed: true }], agents: [] };
    expect(hasChanged(a, b)).toBe(false);
  });
});

describe('createRescanController', () => {
  it('reports on change and skips when unchanged', async () => {
    const scan = vi.fn();
    const initial = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] });
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }], agents: [] });
    const reported: DaemonScanSnapshot[] = [];
    const controller = createRescanController({
      scan: scan as any,
      report: async (s) => { reported.push(s); },
      initial,
    });
    controller.start();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(reported).toHaveLength(0);
    await controller.tickNow();
    expect(reported).toHaveLength(1);
    controller.stop();
  });

  it('swallows scan errors without throwing', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('boom'));
    const controller = createRescanController({ scan: scan as any, report: async () => {}, initial: snap() });
    controller.start();
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    controller.stop();
  });
});
