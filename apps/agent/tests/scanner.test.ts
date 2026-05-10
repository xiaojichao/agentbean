import { describe, it, expect } from 'vitest';
import { scanRuntimes } from '../src/scanner.js';

describe('scanRuntimes', () => {
  it('returns known runtimes with installed flag', async () => {
    const runtimes = await scanRuntimes();
    expect(runtimes.length).toBeGreaterThanOrEqual(3);
    const names = runtimes.map((r) => r.name);
    expect(names).toContain('Claude Code');
    expect(names).toContain('Codex CLI');
    expect(names).toContain('Kimi CLI');
    // Each runtime has required fields
    for (const rt of runtimes) {
      expect(rt).toHaveProperty('name');
      expect(rt).toHaveProperty('adapterKind');
      expect(rt).toHaveProperty('command');
      expect(rt).toHaveProperty('installed');
      expect(typeof rt.installed).toBe('boolean');
    }
  });

  it('includes manus and anygen in runtime checks', async () => {
    const runtimes = await scanRuntimes();
    const names = runtimes.map((r) => r.name);
    expect(names).toContain('Manus');
    expect(names).toContain('Anygen');
  });
});
