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
  test('正文标题取 name、首段取 description、能力小节列表取 capabilities', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# My Coding Agent\n\n这是我负责日常编码的 Agent。\n\n## Capabilities\n\n- Code Review\n- web-search\n- 代码审查\n`);
    const result = scanAgentDescriptor(dir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('My Coding Agent');
    expect(result!.description).toContain('这是我负责日常编码的 Agent');
    // capabilities 从 ## Capabilities 小节提取，小写折叠去重
    expect(result!.capabilities).toEqual(['code review', 'web-search', '代码审查']);
    expect(result!.sourcePath).toContain('AGENTS.md');
  });

  test('中文能力小节（## 能力）同样提取', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# Agent\n\n简介。\n\n## 能力\n\n- 代码审查\n- 单元测试\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.capabilities).toEqual(['代码审查', '单元测试']);
  });

  test('frontmatter 中的 capabilities 字段不读取（生态文件无此标准，避免变相要求改文件）', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\nname: from-frontmatter\ndescription: 来自 frontmatter\ncapabilities:\n  - invented-field\n---\n# Body Title\n正文首段。\n\n## Capabilities\n\n- real-capability\n`);
    const result = scanAgentDescriptor(dir);
    // name/description：正文优先，frontmatter 仅兼容备选
    expect(result!.name).toBe('Body Title');
    expect(result!.description).toContain('正文首段');
    // capabilities 只来自正文小节，frontmatter 的 invented-field 被忽略
    expect(result!.capabilities).toEqual(['real-capability']);
  });

  test('无能力小节时 capabilities 为空数组', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# Agent\n\n只有描述，没有能力小节。\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.name).toBe('Agent');
    expect(result!.description).toContain('只有描述');
    expect(result!.capabilities).toEqual([]);
  });

  test('CLAUDE.md 作为兜底（无 AGENTS.md 时）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'CLAUDE.md'), `# Claude Agent\n\nClaude 专用描述。\n`);
    const result = scanAgentDescriptor(dir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Claude Agent');
    expect(result!.sourcePath).toContain('CLAUDE.md');
  });

  test('AGENTS.md 优先于 CLAUDE.md', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# agents-wins\n\n来自 AGENTS.md。\n`);
    writeFileSync(join(dir, 'CLAUDE.md'), `# claude-wins\n\n来自 CLAUDE.md。\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.name).toBe('agents-wins');
    expect(result!.sourcePath).toContain('AGENTS.md');
  });

  test('目录不存在或两文件都缺失 → null', () => {
    const dir = makeDir();
    expect(scanAgentDescriptor(dir)).toBeNull();
    expect(scanAgentDescriptor(join(dir, 'not-exists'))).toBeNull();
  });

  test('frontmatter name/description 作为正文缺失时的兼容备选', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `---\nname: fm-name\ndescription: fm-desc\n---\n## Capabilities\n\n- cap-a\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.name).toBe('fm-name');
    expect(result!.description).toBe('fm-desc');
    expect(result!.capabilities).toEqual(['cap-a']);
  });

  test('description 截断到 MAX_DESCRIPTION', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# long-desc\n\n${'x'.repeat(3000)}\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.description!.length).toBeLessThanOrEqual(2000);
  });

  test('能力小节内说明文字与代码块不进入 capabilities', () => {
    const dir = makeDir();
    writeAgentsMd(dir, `# Agent\n\n简介。\n\n## Capabilities\n\n以下是能力列表：\n\n- code-review\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n`);
    const result = scanAgentDescriptor(dir);
    expect(result!.capabilities).toEqual(['code-review']);
  });
});

describe('sanitizeCapabilities', () => {
  test('过滤非字符串、小写折叠、去重、限长', () => {
    const caps = sanitizeCapabilities(['Code-Review', 'web-search', 42, null, 'code-review', 'x']);
    expect(caps).toEqual(['code-review', 'web-search', 'x']);
  });
});
