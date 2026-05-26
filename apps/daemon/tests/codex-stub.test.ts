import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';

let scriptPath: string | null = null;
afterEach(() => { if (scriptPath) { try { unlinkSync(scriptPath); } catch {} scriptPath = null; } });

describe('CodexAdapter against a node stub', () => {
  it('returns stdout when child writes to it then exits', async () => {
    // CodexAdapter passes payload as last CLI arg; stub reads from argv
    scriptPath = join(tmpdir(), `stub-${Date.now()}.cjs`);
    writeFileSync(scriptPath, `
      const payload = process.argv[process.argv.length - 1];
      process.stdout.write('ECHO:' + payload.length + '\\n');
    `);
    const adapter = new CodexAdapter({ command: 'node', args: [scriptPath] });
    const out = await adapter.ask({ prompt: 'hi', history: [] }, new AbortController().signal);
    expect(out.startsWith('ECHO:')).toBe(true);
  });

  it('reports a useful error when CLI does not exist', async () => {
    const adapter = new CodexAdapter({ command: '/path/does/not/exist/xyz' });
    await expect(
      adapter.ask({ prompt: 'p', history: [] }, new AbortController().signal),
    ).rejects.toThrow('Codex runtime command is not executable: /path/does/not/exist/xyz');
  });
});
