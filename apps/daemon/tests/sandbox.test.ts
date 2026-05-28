import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSandboxProfile } from '../src/sandbox.js';

let home: string | undefined;
const previousHome = process.env.HOME;

describe('sandbox', () => {
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it('allows writes to the agent workspace and current run directories', () => {
    home = mkdtempSync(join(tmpdir(), 'agentbean-sandbox-home-'));
    process.env.HOME = home;
    const outputDir = join(home, '.agentbean', 'teams', 'team-1', 'agents', 'agent-1', 'runs', 'run-1', 'outputs');
    const intermediateDir = join(home, '.agentbean', 'teams', 'team-1', 'agents', 'agent-1', 'runs', 'run-1', 'intermediates');

    const profilePath = generateSandboxProfile('agent-1', '/opt/homebrew/bin/codex', [outputDir, intermediateDir]);
    const profile = readFileSync(profilePath, 'utf8');

    expect(profile).toContain(`(subpath "${home}/.agentbean/workspaces/agent-1")`);
    expect(profile).toContain(`(subpath "${outputDir}")`);
    expect(profile).toContain(`(subpath "${intermediateDir}")`);
  });
});
