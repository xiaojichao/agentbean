import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const socketClient = readFileSync(new URL('../lib/socket.ts', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../lib/schema.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../components/sidebar.tsx', import.meta.url), 'utf8');
const runsPage = readFileSync(new URL('../app/[networkPath]/runs/page.tsx', import.meta.url), 'utf8');

describe('team workspace runs entrypoint', () => {
  it('fetches team workspace runs from the server-next team route', () => {
    expect(socketClient).toContain('fetchTeamWorkspaceRuns');
    expect(socketClient).toContain('/api/teams/${encodeURIComponent(teamId)}/workspace-runs');
  });

  it('models team workspace run list items with run details and artifacts', () => {
    expect(schema).toContain('export interface TeamWorkspaceRun');
    expect(schema).toContain('workspaceRun: WorkspaceRunDetail');
    expect(schema).toContain('artifacts: WorkspaceArtifact[]');
  });

  it('adds a runs navigation item to the main sidebar', () => {
    expect(sidebar).toContain('/${np}/runs');
    expect(sidebar).toContain('label="运行"');
  });

  it('shows latest team workspace runs and links to run detail pages', () => {
    expect(runsPage).toContain('fetchTeamWorkspaceRuns');
    expect(runsPage).toContain('workspaceRun.status');
    expect(runsPage).toContain('workspaceRun.command');
    expect(runsPage).toContain('workspaceRun.exitCode');
    expect(runsPage).toContain('artifacts.length');
    expect(runsPage).toContain('/${np}/runs/${workspaceRun.id}');
    expect(runsPage).toContain('暂无 workspace runs');
    expect(runsPage).toContain('加载失败');
  });
});
