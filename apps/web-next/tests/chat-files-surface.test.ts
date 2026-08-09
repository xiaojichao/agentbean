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

  test('普通 Markdown 可携带当前 revision 进入 composer', () => {
    expect(filesSurface).toContain('<ProjectDocumentReferenceButton');
    expect(filesSurface).toContain('revisionId={file.documentRevisionId}');
    expect(source).toContain('documentRevisionId: document.currentRevisionId');
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
    expect(source).toContain('<MarkdownMessage body={content} safeDocumentResources collapsible={false} />');
    expect(source).toContain('options.safeDocumentResources && token.startsWith');
    expect(source).toContain('collectSafeMarkdownReferenceDefinitions(body)');
    expect(source).toContain('options.resourceReferences?.get');
    expect(source).toContain("isClosingMarkdownFence(lines[i] ?? '', openingFence)");
    expect(source).toContain('findFirstMarkdownCodeSpan(text)');
    expect(source).toContain('findClosingMarkdownBacktickRun');
  });

  test('files-tab thumbnails and directory mosaics use authenticated artifact URLs', () => {
    // Regression lock for #816 / 0dda5211: raw preview-derivative paths lack ?token=
    // and fail under private artifact auth. Do not reintroduce unauthenticated src.
    expect(source).toMatch(
      /thumbnailUrl=\{artifact\.preview\?\.status === 'ready'[\s\S]*?artifactUrl\(artifact\.preview\.url\)/,
    );
    expect(filesSurface).toContain('artifactUrl(preview)');
  });

  test('逻辑产物只读预览使用带鉴权的 preview/download URL', () => {
    expect(source).toContain("messageArtifactUrl(readOnlyArtifact as unknown as Artifact, 'preview', readOnlyArtifact.teamId)");
    expect(source).toContain("messageArtifactUrl(readOnlyArtifact as unknown as Artifact, 'download', readOnlyArtifact.teamId)");
  });

  test('逻辑产物视图 gate 放宽:无 overview 但有输出包/产物集合也进入 ProjectFilesBoard(#1134)', () => {
    expect(source).toContain("projectFilesAvailable && channelFilesView === 'artifacts'");
    expect(source).toContain('outputPackages.length > 0');
    expect(source).toContain('outputPackagePendings.length > 0');
    expect(source).toContain('(projectArtifactLibrary?.collections.length ?? 0) > 0');
    // stages 容空:overview 缺失时传空数组,等待上游卡自然不出现。
    expect(source).toMatch(/stages=\{channelProjectOverview\?\.stages\.map\(/);
    // 提升入口在无 overview 时关闭(canPromote=false),不误开。
    expect(source).toContain('(channelProjectOverview?.profile.projectLeadId ?? null) === (currentUser?.id ?? null)');
  });

  test('Task 审核入口锁定逻辑产物子视图与目标输出包', () => {
    expect(source).toContain("const focusPackageIdParam = searchParams.get('focusPackageId')");
    expect(source).toContain("const focusPackageRequestParam = searchParams.get('focusPackageRequest')");
    expect(source).toContain("params.set('fileView', 'artifacts')");
    expect(source).toContain('focusPackageId={focusPackageIdParam}');
    expect(source).toContain('focusPackageRequestKey={focusPackageRequestParam}');
    expect(source).toContain("setChannelFilesView('artifacts')");
  });
});
