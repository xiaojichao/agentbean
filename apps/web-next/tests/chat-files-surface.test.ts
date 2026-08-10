import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const filesSurface = source.slice(
  source.indexOf('function ConversationFiles('),
  source.indexOf('function TaskDetailPanel('),
);
const projectFilesBoardSource = readFileSync(
  new URL('../components/project/ProjectFilesBoard.tsx', import.meta.url),
  'utf8',
);

describe('chat files surface', () => {
  test('频道文件标签页只展示逻辑产物，不再暴露普通文件子页面切换', () => {
    expect(source).not.toContain('channel-files-view-files');
    expect(source).not.toContain('channelFilesView');
  });

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

  test('普通文件组件保留复用；无项目投影的频道与私聊挂载它', () => {
    expect(source).toContain('hasProjectFilesSurface');
    expect(source).toMatch(/!isDm && hasProjectFilesSurface \? \(\s+<ProjectFilesBoard/);
    expect(source).toMatch(/<ProjectFilesBoard[\s\S]+?\) : \(\s+<ConversationFiles/);
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

  test('有项目投影才进入逻辑产物板；无投影的普通公共频道回落附件文件页', () => {
    expect(source).toContain('const hasProjectFilesSurface = Boolean(channelProjectOverview)');
    expect(source).toContain('|| outputPackages.length > 0');
    expect(source).toContain('|| outputPackagePendings.length > 0');
    expect(source).toContain('|| (projectArtifactLibrary?.collections.length ?? 0) > 0');
    expect(source).toMatch(/!isDm && hasProjectFilesSurface \? \(\s+<ProjectFilesBoard/);
    // stages 容空:overview 缺失时传空数组,等待上游卡自然不出现。
    expect(source).toMatch(/stages=\{channelProjectOverview\?\.stages\.map\(/);
    // 提升入口在无 overview 时关闭(canPromote=false),不误开。
    expect(source).toContain('(channelProjectOverview?.profile.projectLeadId ?? null) === (currentUser?.id ?? null)');
    // 首轮投影拉取完成前不闪空板。
    expect(source).toContain('files-project-surface-loading');
    expect(source).toContain('setFilesProjectSurfaceReady(true)');
  });

  test('提升入口独立遍历完整文件树，不复用 URL 目录、筛选或当前分页', () => {
    expect(source).toContain('const loadChannelPromotableArtifacts = useCallback');
    expect(source).toContain('loadAllPromotableArtifacts((path, cursor) =>');
    expect(source).toContain("channelEvents().listFiles(activeChannel, cursor, 100, path, 'all')");
    expect(source).toContain('loadPromotableArtifacts={loadChannelPromotableArtifacts}');
    expect(source).not.toContain('promotableArtifacts={channelFiles.map');
  });

  test('私聊与无项目投影频道使用普通文件视图；有投影时用逻辑产物板', () => {
    expect(source).toMatch(/!isDm && hasProjectFilesSurface \? \(\s+<ProjectFilesBoard/);
    expect(source).toMatch(/<ProjectFilesBoard[\s\S]+?\) : \(\s+<ConversationFiles/);
    expect(source).toContain('const isActiveDm = dms.some((dm) => dm.id === activeChannel);');
    expect(source).toContain('const useAttachmentFiles = isActiveDm');
    expect(source).toContain('filesProjectSurfaceReady && !hasProjectFilesSurface');
  });

  test('文件库对齐原型：不渲染频道文档/文档包顶栏，也不再挂 documentReferenceSection', () => {
    expect(source).not.toContain('documentReferenceSection');
    expect(source).not.toContain('<ProjectDocumentList');
    expect(source).not.toContain('<ProjectDocumentBundleList');
    expect(projectFilesBoardSource).not.toContain('documentReferenceSection');
    expect(projectFilesBoardSource).not.toContain('files-document-reference-section');
    // ChannelDocument 数量不得参与门禁。
    expect(source).not.toMatch(/hasProjectFilesSurface[\s\S]{0,200}projectDocuments/);
    // listDocuments 仍可服务于附件行 documentId 映射，但不驱动顶栏列表。
    expect(source).toContain('channelEvents().listDocuments(activeChannel)');
  });
});
