// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  submitPackageArtifactReview: vi.fn(),
  artifactCollections: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    artifactCollections: mocks.artifactCollections,
  }),
}));

import { OutputPackageCard } from '../components/OutputPackageCard';
import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// 默认:无产物库信息(file-sub 不渲染),getOutputPackage 由各用例自设。
mocks.artifactCollections.mockResolvedValue({ ok: false });

const packageMeta = {
  kind: 'output-package' as const,
  packageId: 'pkg-1',
  taskId: 'task-1',
  taskTitle: '写剧本',
  agentName: 'Agent-A',
  memberCount: 2,
  members: [
    { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
    { shortLabel: 'F2', filename: 'ep2.md', artifactVersionId: 'ver-2', collectionId: 'col-2' },
  ],
  workspaceRevisionId: 'rev-1',
  publishId: 'pub-1',
  createdAt: 1000,
};

const readyProjection = {
  policy: 'current' as const,
  status: 'ready' as const,
  members: [
    {
      sequence: 1, shortLabel: 'F1', collectionId: 'col-1', versionId: 'ver-1',
      versionNumber: 1, artifactId: 'art-1', filename: 'ep1.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 3,
    },
    {
      sequence: 2, shortLabel: 'F2', collectionId: 'col-2', versionId: 'ver-2',
      versionNumber: 1, artifactId: 'art-2', filename: 'ep2.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 1,
    },
  ],
  blockers: [],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

const notReadyProjection = {
  policy: 'final' as const,
  status: 'not_ready' as const,
  members: [],
  blockers: [{ code: 'missing_final' as const, collectionId: 'col-1', shortLabel: 'F1', filename: 'ep1.md' }],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

describe('文件包统一引用', () => {
  function setup() {
    const onAddReference = vi.fn();
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" onAddReference={onAddReference} />);
    return onAddReference;
  }
  async function loaded() {
    await waitFor(() => expect((screen.getByRole('button', { name: /引用(全部|所选)/ }) as HTMLButtonElement).disabled).toBe(false));
  }
  test('默认全选与当前版，整包保留 revision fence；没有重复引用入口', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, projection: readyProjection });
    const add = setup();
    await loaded();
    expect((screen.getByRole('checkbox', { name: '全选文件' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('选择成员')).toBeNull();
    expect(screen.queryByRole('button', { name: '引用', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '引用全部 2 个文件' }));
    expect(add).toHaveBeenCalledWith({ kind: 'package_projection', packageId: 'pkg-1', policy: 'current', expectedMemberRevisions: [{ collectionId: 'col-1', revision: 3 }, { collectionId: 'col-2', revision: 1 }] });
    expect(screen.getByRole('status').textContent).toBe('已加入输入框');
    expect(screen.getByText('PKG-pkg-1')).toBeTruthy();
  });
  test('部分引用冻结显示的最新版本，不误用原始交付版本', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, projection: { ...readyProjection, members: readyProjection.members.map((member) => ({ ...member, versionId: member.versionId + '-current', versionNumber: 3 })) } });
    const add = setup();
    await loaded();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 F2 ep2.md' }));
    expect((screen.getByRole('checkbox', { name: '全选文件' }) as HTMLInputElement).indeterminate).toBe(true);
    expect(screen.getAllByText(/当前版 v3/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '引用所选 1 个文件' }));
    expect(add).toHaveBeenCalledWith({ kind: 'package_members', packageId: 'pkg-1', members: [{ collectionId: 'col-1', versionId: 'ver-1-current' }] });
  });
  test('最终版缺失时保留勾选并阻断；取消缺失项后可引用剩余最终版', async () => {
    mocks.getOutputPackage.mockImplementation(async ({ projection }) => ({ ok: true, projection: projection.policy === 'final' ? { ...notReadyProjection, members: [{ ...readyProjection.members[1], versionId: 'final-2', versionNumber: 2, isFinalVersion: true }] } : readyProjection }));
    const add = setup();
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: '引用版本' }), { target: { value: 'final' } });
    await screen.findByText('尚未设置最终版');
    expect((screen.getByRole('checkbox', { name: '选择 F1 ep1.md' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: '引用全部 2 个文件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 F1 ep1.md' }));
    fireEvent.click(screen.getByRole('button', { name: '引用所选 1 个文件' }));
    expect(add).toHaveBeenCalledWith({ kind: 'package_members', packageId: 'pkg-1', members: [{ collectionId: 'col-2', versionId: 'final-2' }] });
  });
  test('空选择禁用，重新全选恢复；交付版不包含 revision fence', async () => {
    mocks.getOutputPackage.mockImplementation(async ({ projection }) => ({ ok: true, projection: { ...readyProjection, policy: projection.policy } }));
    const add = setup();
    await loaded();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选文件' }));
    expect(screen.getByRole('status').textContent).toBe('请选择文件');
    expect((screen.getByRole('button', { name: '引用所选 0 个文件' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '全选文件' }));
    fireEvent.change(screen.getByRole('combobox', { name: '引用版本' }), { target: { value: 'delivered' } });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: '引用全部 2 个文件' }));
    expect(add).toHaveBeenCalledWith({ kind: 'package_projection', packageId: 'pkg-1', policy: 'delivered' });
  });
  test('被要求修改的当前版不可通过部分选择绕过，预览绑定显示的版本', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, projection: { ...readyProjection, status: 'not_ready', members: readyProjection.members.map((member) => ({ ...member, versionId: member.versionId + '-current', versionNumber: 3 })), blockers: [{ code: 'current_not_formal', collectionId: 'col-1' }] } });
    const add = vi.fn();
    const preview = vi.fn();
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" onAddReference={add} onOpenPreview={preview} />);
    await screen.findByText('当前版已被拒绝或要求修改，请在预览中处理');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 F2 ep2.md' }));
    expect((screen.getByRole('button', { name: '引用所选 1 个文件' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: '预览' })[0]);
    expect(preview).toHaveBeenCalledWith('ver-1-current', true);
    expect(add).not.toHaveBeenCalled();
  });
  test('加载失败可重试，不能产生引用', async () => {
    mocks.getOutputPackage.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, projection: readyProjection });
    const add = setup();
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: '引用全部 2 个文件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await loaded();
  });
  test('切换版本后忽略迟到的旧响应', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.getOutputPackage.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ ok: true, projection: { ...readyProjection, policy: 'delivered' } });
    const add = setup();
    fireEvent.change(screen.getByRole('combobox', { name: '引用版本' }), { target: { value: 'delivered' } });
    await loaded();
    await act(async () => { resolveOld({ ok: true, projection: notReadyProjection }); });
    fireEvent.click(screen.getByRole('button', { name: '引用全部 2 个文件' }));
    expect(add).toHaveBeenCalledWith({ kind: 'package_projection', packageId: 'pkg-1', policy: 'delivered' });
    expect(screen.queryByText('尚未设置最终版')).toBeNull();
  });
});

/** 原型对齐:成员行 file-sub(collection 名 · current server 版本 · 来源/修改时间)。 */
describe('OutputPackageCard 成员行 file-sub', () => {
  test('显示 collection 名、current server 版本与手动修改来源', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, availableActions: [], package: undefined });
    mocks.artifactCollections.mockResolvedValue({
      ok: true,
      library: {
        archived: false,
        collections: [
          {
            id: 'col-1',
            name: 'script.ep01',
            currentVersionId: 'ver-cur-1',
            versions: [
              { id: 'ver-cur-1', versionNumber: 4, createdAt: Date.now(), revisionBasis: { sourceVersionId: 'ver-1' } },
            ],
          },
          {
            id: 'col-2',
            name: 'character.sheet',
            currentVersionId: 'ver-cur-2',
            versions: [
              { id: 'ver-cur-2', versionNumber: 3, createdAt: Date.now() },
            ],
          },
        ],
      },
    });
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" />);
    await waitFor(() => {
      const subs = Array.from(document.querySelectorAll('[data-smoke="package-member-sub"]'));
      expect(subs.length).toBe(2);
    });
    const subs = Array.from(document.querySelectorAll('[data-smoke="package-member-sub"]')).map((el) => el.textContent);
    expect(subs[0]).toContain('collection: script.ep01');
    expect(subs[0]).toContain('current server v4');
    expect(subs[0]).toContain('手动修改');
    expect(subs[1]).toContain('collection: character.sheet');
    expect(subs[1]).toContain('current server v3');
    expect(subs[1]).toContain('Agent 交付');
  });

  test('artifactCollections 失败时降级不显示 file-sub,不抛错', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, availableActions: [], package: undefined });
    mocks.artifactCollections.mockRejectedValue(new Error('boom'));
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" />);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="output-package-card"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="package-member-sub"]')).toBeNull();
  });
});
