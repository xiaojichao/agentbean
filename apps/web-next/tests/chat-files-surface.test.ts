import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const projectWorkspaceSource = readFileSync(
  new URL('../lib/use-channel-project-workspace.ts', import.meta.url),
  'utf8',
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
    expect(source).toContain('<ChatArtifactPreview');
    expect(source).not.toContain('title="预览文件"');
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

  test('逻辑产物只读预览使用带鉴权的 preview/download URL', () => {
    expect(source).toContain("messageArtifactUrl(readOnlyArtifact as unknown as Artifact, 'preview', readOnlyArtifact.teamId)");
    expect(source).toContain("messageArtifactUrl(readOnlyArtifact as unknown as Artifact, 'download', readOnlyArtifact.teamId)");
  });

  test('所有会话统一渲染逻辑产物板；无项目数据面呈现空板（产品决策 2026-08-30）', () => {
    expect(source).toMatch(/activeChannel \? \(\s+\/\/ 所有会话（含 #all\/私聊）统一渲染文件库逻辑产物板[\s\S]+?<ProjectFilesBoard/);
    expect(source).not.toContain('hasProjectFilesSurface');
    expect(source).not.toContain('<ConversationFiles');
    expect(source).not.toContain('function ConversationFiles');
    // 附件浏览数据链已退役（50 分页形态是旧附件浏览；提升遍历的 100 分页保留）。
    expect(source).not.toContain('channelEvents().listFiles(activeChannel, cursor, 50,');
    expect(source).not.toContain('const useAttachmentFiles');
    // 首轮投影拉取完成前不闪空板。
    expect(source).toContain('files-project-surface-loading');
    expect(source).toContain('const filesProjectSurfaceReady = projectWorkspace.filesReady');
    expect(projectWorkspaceSource).toContain('setFilesReady(true)');
    // stages 容空:overview 缺失时传空数组,等待上游卡自然不出现。
    expect(source).toMatch(/stages=\{channelProjectOverview\?\.stages\.map\(/);
    // 提升入口在无 overview 时关闭(canPromote=false),不误开。
    expect(source).toContain('(channelProjectOverview?.profile.projectLeadId ?? null) === (currentUser?.id ?? null)');
  });

  test('提升入口独立遍历完整文件树，不复用 URL 目录、筛选或当前分页', () => {
    expect(source).toContain('const loadChannelPromotableArtifacts = useCallback');
    expect(source).toContain('loadAllPromotableArtifacts((path, cursor) =>');
    expect(source).toContain("channelEvents().listFiles(activeChannel, cursor, 100, path, 'all')");
    expect(source).toContain('loadPromotableArtifacts={loadChannelPromotableArtifacts}');
    expect(source).not.toContain('promotableArtifacts={channelFiles.map');
  });

  test('文件库对齐原型：不渲染频道文档/文档包顶栏，也不再挂 documentReferenceSection', () => {
    expect(source).not.toContain('documentReferenceSection');
    expect(source).not.toContain('<ProjectDocumentList');
    expect(source).not.toContain('<ProjectDocumentBundleList');
    expect(projectFilesBoardSource).not.toContain('documentReferenceSection');
    expect(projectFilesBoardSource).not.toContain('files-document-reference-section');
  });

  test('Task、Files 与讨论串复用同一个文件包预览审核弹窗', () => {
    expect(source).toContain('onOpenPackagePreview={openPackagePreviewModal}');
    expect(source).toMatch(/<StageDeliveryReviewWorkspace[\s\S]*?onOpenPackagePreview=\{onOpenPackagePreview\}/);
    expect(source).toMatch(/<ProjectFilesBoard[\s\S]*?onOpenPackagePreview=\{openPackagePreviewModal\}/);
    expect(source).toMatch(/<ThreadPanel[\s\S]*?onOpenPackagePreview=\{openPackagePreviewModal\}/);
    expect(source).toContain('openPackagePreview.readOnly || activeChannelObj?.archivedAt');
    expect(source).toMatch(/<ThreadPanel[\s\S]*?dataRevision=\{projectDataRevision\}/);
    expect(source).toMatch(/onSaved=\{\(\) => \{[\s\S]*?refreshProjectArtifactLibrary\(\);[\s\S]*?refreshOutputPackages\(\);[\s\S]*?\}\}/);
  });

  test('左栏空态区分无数据与无匹配', () => {
    expect(projectFilesBoardSource).toContain(`{displayCards.length === 0 ? '暂无文件组' : '无匹配文件组'}`);
  });
});
