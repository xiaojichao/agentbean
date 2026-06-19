import { existsSync, mkdtempSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  prepareWorkspaceRun,
  workspaceRunEnv,
  persistWorkspaceRunManifest,
  persistWorkspaceRunResponse,
  workspaceRunPath,
} from '../src/workspace-run';

describe('workspace-run', () => {
  test('prepareWorkspaceRun creates inputs/outputs/logs under {cwd}/.agentbean/runs/{runId}', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    expect(ws.runDir).toBe(join(cwd, '.agentbean', 'runs', 'run-1'));
    expect(existsSync(ws.inputDir)).toBe(true);
    expect(existsSync(ws.outputDir)).toBe(true);
    expect(existsSync(ws.logsDir)).toBe(true);
  });

  test('workspaceRunPath is stable for the same cwd/runId', () => {
    expect(workspaceRunPath('/proj', 'r9')).toBe(join('/proj', '.agentbean', 'runs', 'r9'));
  });

  test('workspaceRunEnv exposes run id and the three dirs', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    const env = workspaceRunEnv(ws);
    expect(env.AGENTBEAN_RUN_ID).toBe('run-1');
    expect(env.AGENTBEAN_INPUT_DIR).toBe(ws.inputDir);
    expect(env.AGENTBEAN_OUTPUT_DIR).toBe(ws.outputDir);
    expect(env.AGENTBEAN_WORKSPACE).toBe(ws.runDir);
  });

  test('persistWorkspaceRunManifest writes valid JSON with file list', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    persistWorkspaceRunManifest(ws, {
      runId: 'run-1',
      status: 'succeeded',
      startedAt: 1000,
      completedAt: 2000,
      exitCode: 0,
      files: [{ relativePath: 'outputs/out.png', sha256: 'abc', sizeBytes: 10, filename: 'out.png' }],
    });
    const parsed = JSON.parse(readFileSync(ws.manifestPath, 'utf8'));
    expect(parsed.runId).toBe('run-1');
    expect(parsed.files[0].sha256).toBe('abc');
  });

  test('persistWorkspaceRunResponse writes the reply body', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    persistWorkspaceRunResponse(ws, 'hello reply');
    expect(readFileSync(ws.responsePath, 'utf8')).toBe('hello reply');
  });

  test('two runIds get isolated directories', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const a = prepareWorkspaceRun(cwd, 'run-a');
    const b = prepareWorkspaceRun(cwd, 'run-b');
    expect(a.outputDir).not.toBe(b.outputDir);
    expect(readdirSync(join(cwd, '.agentbean', 'runs')).sort()).toEqual(['run-a', 'run-b']);
  });
});
