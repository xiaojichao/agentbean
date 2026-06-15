import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const socketClient = readFileSync(new URL('../lib/socket.ts', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../lib/schema.ts', import.meta.url), 'utf8');
const workspaceSection = readFileSync(new URL('../components/agent-workspace-section.tsx', import.meta.url), 'utf8');
const devicePage = readFileSync(new URL('../app/[networkPath]/devices/page.tsx', import.meta.url), 'utf8');

describe('agent workspace run entrypoints', () => {
  it('fetches agent workspace runs from the server-next team route', () => {
    expect(socketClient).toContain('/api/teams/${encodeURIComponent(networkId)}/agents/${encodeURIComponent(agentId)}/workspace');
  });

  it('models run status and command metadata for workspace cards', () => {
    expect(schema).toContain("status: WorkspaceRunStatus");
    expect(schema).toContain('command?: string');
    expect(schema).toContain('exitCode?: number');
  });

  it('shows workspace run status and command context in agent cards', () => {
    expect(workspaceSection).toContain('run.status');
    expect(workspaceSection).toContain('run.command');
    expect(workspaceSection).toContain('查看详情');
  });

  it('shows workspace run status in device workspace cards', () => {
    expect(devicePage).toContain('run.status');
    expect(devicePage).toContain('run.command');
    expect(devicePage).toContain('查看详情');
  });
});
