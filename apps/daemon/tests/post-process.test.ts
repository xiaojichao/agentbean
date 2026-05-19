import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { postProcess } from '../src/post-process.js';

describe('postProcess', () => {
  afterEach(() => {
    delete process.env.AGENT_BEAN_OUTPUT_DIRS;
  });

  it('detects newly generated files mentioned in the agent reply', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentbean-post-process-'));
    const filePath = join(workspace, 'output.png');
    const dispatchStart = Date.now() - 1000;
    writeFileSync(filePath, 'fake image');

    const result = await postProcess(`生成完成：![output](output.png)`, workspace, 'codex', dispatchStart);

    expect(result.outputFiles).toContain(realpathSync(filePath));
    expect(result.replyText).toContain('已生成文件');
  });

  it('detects new image files created in explicit workspace output directories', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentbean-post-process-'));
    const outputDir = join(workspace, 'outputs', 'covers');
    mkdirSync(outputDir, { recursive: true });
    const filePath = join(outputDir, 'daily-ai-news.png');
    const dispatchStart = Date.now() - 1000;
    writeFileSync(filePath, 'fake image');

    const result = await postProcess('(Codex 已完成处理)', workspace, 'codex', dispatchStart, { outputDirs: ['outputs'] });

    expect(result.outputFiles).toContain(realpathSync(filePath));
  });

  it('does not scan the whole project workspace for unmentioned files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentbean-post-process-'));
    const filePath = join(workspace, 'unmentioned.png');
    const dispatchStart = Date.now() - 1000;
    writeFileSync(filePath, 'fake image');

    const result = await postProcess('(Codex 已完成处理)', workspace, 'codex', dispatchStart);

    expect(result.outputFiles).not.toContain(realpathSync(filePath));
  });

  it('detects new files in explicit daemon output directories', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentbean-post-process-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'agentbean-external-output-'));
    const filePath = join(externalDir, 'cover.webp');
    const dispatchStart = Date.now() - 1000;
    writeFileSync(filePath, 'fake image');
    process.env.AGENT_BEAN_OUTPUT_DIRS = externalDir;

    const result = await postProcess('(Codex 已完成处理)', workspace, 'codex', dispatchStart);

    expect(result.outputFiles).toContain(realpathSync(filePath));
  });
});
