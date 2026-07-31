import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanAgentDescriptor, sanitizeCapabilities } from '../src/descriptor-scanner';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'descriptor-'));
}

function writeAgentsMd(dir: string, content: string) {
  writeFileSync(join(dir, 'AGENTS.md'), content);
}

describe('scanAgentDescriptor', () => {
  test('frontmatter 完整解析 name/description/capabilities', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\nname: my-agent\ndescription: 负责代码审查\ncapabilities:\n  - code-review\n  - Web-Search\n---\n# my-agent\n正文说明\n`);
    const result = scanAgentDescriptor(dir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-agent');
    expect(result!.description).toBe('负责代码审查');
    // capabilities 小写折叠去重
    expect(result!.capabilities).toEqual(['code-review', 'web-search']);
    expect(result!.sourcePath).toContain('AGENTS.md');
  });

  test('无 frontmatter 时从正文提取标题和首段', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# My Coding Agent\n\n这是我负责日常编码的 Agent。\n\n## 其他段落\n后续内容\n`);
    const result = scanAgentDescriptor(dir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('My Coding Agent');
    expect(result!.description).toContain('这是我负责日常编码的 Agent');
    expect(result!.capabilities).toEqual([]);
  });

  test('CLAUDE.md 作为兜底（无 AGENTS.md 时）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'CLAUDE.md'), `---\nname: claude-agent\ndescription: Claude 专用\n---\n正文\n`);
    const result = scanAgentDescriptor(dir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('claude-agent');
    expect(result!.sourcePath).toContain('CLAUDE.md');
  });

  test('AGENTS.md 优先于 CLAUDE.md', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\nname: agents-wins\ndescription: 来自 AGENTS.md\n---\n`);
    writeFileSync(join(dir, 'CLAUDE.md'), `---\nname: claude-wins\ndescription: 来自 CLAUDE.md\n---\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.name).toBe('agents-wins');
    expect(result!.sourcePath).toContain('AGENTS.md');
  });

  test('目录不存在或两文件都缺失 → null', () => {
    const dir = makeDir();
    expect(scanAgentDescriptor(dir)).toBeNull();
    expect(scanAgentDescriptor(join(dir, 'not-exists'))).toBeNull();
  });

  test('frontmatter 缺 name 时回退正文标题', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\ndescription: 只有描述\n---\n# Title From Body\n正文\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.name).toBe('Title From Body');
    expect(result!.description).toBe('只有描述');
  });

  test('description 截断到 MAX_DESCRIPTION', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\nname: long-desc\ndescription: ${'x'.repeat(3000)}\n---\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.description!.length).toBeLessThanOrEqual(2000);
  });
});

describe('sanitizeCapabilities', () => {
  test('过滤非字符串、小写折叠、去重、限长', () => {
    const caps = sanitizeCapabilities(['Code-Review', 'web-search', 42, null, 'code-review', 'x']);
    expect(caps).toEqual(['code-review', 'web-search', 'x']);
  });
});
