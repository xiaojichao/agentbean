import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createManagementRuntimeFactory,
  type ManagementModelRequest,
  type ManagementRuntimeEvent,
} from '../src/index.js';

describe('hermetic management resources', () => {
  it('ignores global and project PI resources, context files, and cwd content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-pi-hermetic-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true });
    mkdirSync(join(cwd, '.pi', 'skills', 'malicious'), { recursive: true });
    mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'extensions', 'malicious.js'), 'GLOBAL_SECRET_MARKER');
    writeFileSync(join(cwd, '.pi', 'skills', 'malicious', 'SKILL.md'), 'PROJECT_SECRET_MARKER');
    writeFileSync(join(cwd, '.pi', 'extensions', 'malicious.js'), 'PROJECT_EXTENSION_SECRET_MARKER');
    writeFileSync(join(cwd, 'AGENTS.md'), 'AGENTS_SECRET_MARKER');
    writeFileSync(join(cwd, 'CLAUDE.md'), 'CLAUDE_SECRET_MARKER');

    const requests: ManagementModelRequest[] = [];
    const events: ManagementRuntimeEvent[] = [];
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    try {
      process.env.HOME = home;
      process.chdir(cwd);
      const session = await createManagementRuntimeFactory({
        model: {
          id: 'hermetic',
          async respond(request) {
            requests.push(request);
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
        toolExecutor: async () => ({ text: 'unused' }),
      }).createSession({
        systemPrompt: { id: 'manager', version: 7, content: 'EXPLICIT_SYSTEM_PROMPT' },
      });

      session.subscribe((event) => events.push(event));
      await session.prompt({ text: 'go' });
      await session.waitForIdle();
      await session.dispose();
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }

    const serialized = JSON.stringify(requests);
    expect(serialized).toContain('EXPLICIT_SYSTEM_PROMPT');
    expect(requests[0]?.systemPrompt).toBe('EXPLICIT_SYSTEM_PROMPT');
    expect(serialized).not.toMatch(/GLOBAL_SECRET_MARKER|PROJECT_SECRET_MARKER|PROJECT_EXTENSION_SECRET_MARKER|AGENTS_SECRET_MARKER|CLAUDE_SECRET_MARKER/);
    const diagnostics = JSON.stringify(events);
    expect(diagnostics).not.toContain('EXPLICIT_SYSTEM_PROMPT');
    expect(diagnostics).not.toContain(root);
    expect(diagnostics).not.toMatch(/SECRET_MARKER/);
  });
});
