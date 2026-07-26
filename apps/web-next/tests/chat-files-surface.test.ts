import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const filesSurface = source.slice(
  source.indexOf('function ConversationFiles('),
  source.indexOf('function TaskDetailPanel('),
);

describe('chat files surface', () => {
  test('reuses the shared Artifact viewer instead of opening previews in a new tab', () => {
    expect(filesSurface).toContain('<ChatArtifactPreview');
    expect(filesSurface).not.toContain('target="_blank"');
    expect(filesSurface).not.toContain('title="预览文件"');
  });

  test('ignores stale file responses after the channel or search query changes', () => {
    expect(source).toContain('const channelFilesRequestRevisionRef = useRef(0)');
    expect(source).toContain('if (requestRevision !== channelFilesRequestRevisionRef.current) return;');
    expect(source).toContain('if (requestRevision === channelFilesRequestRevisionRef.current)');
    expect(source).toMatch(/useEffect\(\(\) => \{\s+channelFilesRequestRevisionRef\.current \+= 1;\s+setChannelFiles\(\[\]\)/);
  });

  test('keeps directory navigation in the URL and exposes role filtering', () => {
    expect(source).toContain("searchParams.get('filePath')");
    expect(source).toContain("params.set('filePath', path)");
    expect(source).toContain("params.delete('filePath')");
    expect(filesSurface).toContain('按文件角色筛选');
    expect(filesSurface).toContain('directories.map');
    expect(source).toContain('data-smoke="chat-file-input"');
  });

  test('派生 Run Markdown 前明确确认且同名时要求改名', () => {
    expect(source).toContain('编辑此 Run Markdown 将创建新的 Channel document');
    expect(source).toContain('原 Run Artifact 和运行目录不会被修改');
    expect(source).toContain('.deriveDocument(activeChannel, artifact.id, sourceContent, filename)');
    expect(source).toContain('频道中已有同名文档。请输入新的文档名称');
  });

  test('保存后用服务端固定资源后的 revision 内容刷新编辑器且不改变普通聊天图片语义', () => {
    expect(source).toContain("messageArtifactUrl(savedArtifact, 'preview', savedArtifact.teamId)");
    expect(source).toContain('content: savedContent');
    expect(source).toContain('<MarkdownMessage body={content} safeDocumentResources />');
    expect(source).toContain('options.safeDocumentResources && token.startsWith');
    expect(source).toContain('collectSafeMarkdownReferenceDefinitions(body)');
    expect(source).toContain('options.resourceReferences?.get');
    expect(source).toContain("isClosingMarkdownFence(lines[i] ?? '', openingFence)");
    expect(source).toContain('findFirstMarkdownCodeSpan(text)');
    expect(source).toContain('findClosingMarkdownBacktickRun');
  });
});
