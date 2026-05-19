import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveOutputFiles, beginAgentWorkspaceRun, finishAgentWorkspaceRun, formatWorkspaceReply, workspaceEnv } from '../src/workspace-manager.js';

let home: string | undefined;

describe('workspace-manager', () => {
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    delete process.env.AGENTBEAN_HOME;
  });

  it('creates team/agent run directories and archives output files', () => {
    home = mkdtempSync(join(tmpdir(), 'agentbean-home-'));
    process.env.AGENTBEAN_HOME = home;
    const sourceDir = mkdtempSync(join(tmpdir(), 'agentbean-output-source-'));
    const sourceFile = join(sourceDir, 'cover.png');
    writeFileSync(sourceFile, 'fake image');

    const run = beginAgentWorkspaceRun({
      teamId: 'team-1',
      teamName: 'Testsns',
      agentId: 'agent-1',
      agentName: 'drama',
      runId: 'run-1',
      prompt: '生成封面图',
      projectDir: sourceDir,
    });
    const env = workspaceEnv(run);
    expect(env.AGENTBEAN_OUTPUT_DIR).toBe(run.outputDir);

    const archived = archiveOutputFiles(run, [sourceFile]);
    finishAgentWorkspaceRun(run, { replyText: 'ok', files: archived, status: 'completed' });

    expect(archived[0]?.relativePath).toBe('runs/run-1/outputs/cover.png');
    expect(existsSync(join(run.runDir, 'prompt.md'))).toBe(true);
    expect(readFileSync(join(run.runDir, 'response.md'), 'utf8')).toBe('ok');
    expect(existsSync(join(run.outputDir, 'cover.png'))).toBe(true);
  });

  it('formats replies with archived workspace paths instead of original device paths', () => {
    home = mkdtempSync(join(tmpdir(), 'agentbean-home-'));
    process.env.AGENTBEAN_HOME = home;
    const sourceDir = mkdtempSync(join(tmpdir(), 'agentbean-output-source-'));
    const sourceFile = join(sourceDir, 'cover.png');
    writeFileSync(sourceFile, 'fake image');

    const run = beginAgentWorkspaceRun({
      teamId: 'team-1',
      agentId: 'agent-1',
      agentName: 'drama',
      runId: 'run-1',
      prompt: '生成封面图',
      projectDir: sourceDir,
    });
    const archived = archiveOutputFiles(run, [sourceFile]);

    const reply = formatWorkspaceReply(`已生成文件:\n- ${sourceFile}`, archived);

    expect(reply).not.toContain(sourceFile);
    expect(reply).toContain(archived[0]!.archivedPath);
  });

  it('adds archived workspace paths when the reply does not mention generated files', () => {
    home = mkdtempSync(join(tmpdir(), 'agentbean-home-'));
    process.env.AGENTBEAN_HOME = home;
    const sourceDir = mkdtempSync(join(tmpdir(), 'agentbean-output-source-'));
    const sourceFile = join(sourceDir, 'cover.png');
    writeFileSync(sourceFile, 'fake image');

    const run = beginAgentWorkspaceRun({
      teamId: 'team-1',
      agentId: 'agent-1',
      runId: 'run-1',
      prompt: '生成封面图',
      projectDir: sourceDir,
    });
    const archived = archiveOutputFiles(run, [sourceFile]);

    const reply = formatWorkspaceReply('图片已完成。', archived);

    expect(reply).toContain('已生成文件');
    expect(reply).toContain(archived[0]!.archivedPath);
    expect(reply).not.toContain(sourceFile);
  });
});
