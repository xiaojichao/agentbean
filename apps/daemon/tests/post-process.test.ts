import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postProcess } from '../src/post-process.js';

describe('postProcess', () => {
  it('detects newly generated files mentioned in the agent reply', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentbean-post-process-'));
    const filePath = join(workspace, 'output.png');
    const dispatchStart = Date.now() - 1000;
    writeFileSync(filePath, 'fake image');

    const result = await postProcess(`生成完成：![output](output.png)`, workspace, 'codex', dispatchStart);

    expect(result.outputFiles).toContain(filePath);
    expect(result.replyText).toContain('已生成文件');
  });
});
