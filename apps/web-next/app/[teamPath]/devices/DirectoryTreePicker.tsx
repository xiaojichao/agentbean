'use client';

// fs:list 树形目录选择器（切片4，#639）。
// 把「在 daemon 屏幕上弹原生窗」（DirectoryBrowseButton 的 osascript 路径）搬到
// 「在浏览器里渲染树」：逐层懒加载目标设备文件系统，选中目录填入表单 cwd。
// 远程/headless 设备借此首次获得全功能目录浏览（spec §5.3）。
//
// 状态逻辑全部在 lib/directory-tree.ts（扁平 record + immutable 迁移，可单测）；
// 本组件只负责渲染与发请求。旧 DirectoryBrowseButton 保留作旧 daemon 降级入口（切片5 接线）。

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Loader2, X } from 'lucide-react';
import { deviceEvents } from '@/lib/socket';
import {
  applyDirectoryListFailure,
  applyDirectoryListSuccess,
  breadcrumbSegments,
  DIRECTORY_ENTRIES_TRUNCATE_LIMIT,
  initialDirectoryTreeState,
  markDirectoryLoading,
  needsDirectoryFetch,
  toggleDirectoryExpanded,
  visibleDirectoryRows,
  type DirectoryTreeState,
} from '@/lib/directory-tree';

export function DirectoryTreePicker({
  deviceId,
  onSelect,
  onClose,
}: {
  deviceId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [tree, setTree] = useState<DirectoryTreeState>(() => initialDirectoryTreeState());
  const [selected, setSelected] = useState('');

  const fetchPath = useCallback(
    async (path: string) => {
      setTree((s) => markDirectoryLoading(s, path));
      try {
        const ack = await deviceEvents().listDirectory(deviceId, path);
        setTree((s) => (ack.ok ? applyDirectoryListSuccess(s, path, ack) : applyDirectoryListFailure(s, path, ack.error)));
      } catch (error) {
        setTree((s) => applyDirectoryListFailure(s, path, error instanceof Error ? error.message : undefined));
      }
    },
    [deviceId],
  );

  // 打开即拉根锚点（'' → daemon 返回 $HOME 下一层 + homePath）
  useEffect(() => {
    void fetchPath('');
  }, [fetchPath]);

  const toggleRow = (path: string) => {
    // 展开且从未加载过 → 懒加载该层（失败过也允许重试）。
    // 决策必须在 setTree updater 外做：updater 要纯（StrictMode 会双调用），
    // 在 updater 里发请求会重复发 + render 期嵌套 setState。
    if (tree.expanded[path] !== true && needsDirectoryFetch(tree, path)) {
      void fetchPath(path);
    }
    setTree((s) => toggleDirectoryExpanded(s, path));
  };

  const rows = visibleDirectoryRows(tree);
  const rootLoading = tree.homePath === undefined && Object.keys(tree.errors).length === 0;
  const rootError = tree.homePath === undefined ? Object.values(tree.errors)[0] : undefined;
  const selectedSegments = breadcrumbSegments(selected || tree.homePath || '');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 pb-2">
          <h2 className="text-base font-semibold">选择项目目录</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-neutral-100"><X size={16} /></button>
        </div>

        {/* 面包屑：当前选中的绝对路径，点击任意段即选中该层 */}
        {selectedSegments.length > 0 && (
          <div className="flex flex-wrap items-center gap-0.5 px-4 pb-2 font-mono text-[11px] text-neutral-500">
            {selectedSegments.map((seg, i) => (
              <span key={seg.path} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-neutral-300">/</span>}
                <button
                  type="button"
                  onClick={() => setSelected(seg.path)}
                  className={`rounded px-0.5 hover:bg-neutral-100 ${selected === seg.path ? 'font-semibold text-neutral-900' : ''}`}
                >
                  {seg.label}
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="min-h-[240px] flex-1 overflow-y-auto border-t border-neutral-100 px-2 py-2">
          {rootLoading && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-400">
              <Loader2 size={16} className="animate-spin" /> 正在读取设备目录…
            </div>
          )}
          {rootError && (
            <div className="flex flex-col items-center gap-2 py-16">
              <p className="text-sm text-red-600">{rootError}</p>
              <button type="button" onClick={() => void fetchPath('')} className="rounded-md border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
                重试
              </button>
            </div>
          )}
          {!rootLoading && !rootError && rows.length === 0 && (
            <p className="py-16 text-center text-sm text-neutral-400">该目录下没有子目录</p>
          )}
          {rows.map((row) => (
            <div key={row.path}>
              <div
                className={`flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm hover:bg-neutral-50 ${selected === row.path ? 'bg-neutral-100' : ''}`}
                style={{ paddingLeft: `${row.depth * 16 + 6}px` }}
                onClick={() => setSelected(row.path)}
              >
                <button
                  type="button"
                  aria-label={row.expanded ? `折叠 ${row.name}` : `展开 ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRow(row.path);
                  }}
                  className="rounded p-0.5 text-neutral-400 hover:bg-neutral-200"
                >
                  {row.loading ? <Loader2 size={12} className="animate-spin" /> : row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <FolderOpen size={13} className="shrink-0 text-neutral-400" />
                <span className="truncate">{row.name}</span>
              </div>
              {row.error && (
                <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: `${row.depth * 16 + 30}px` }}>
                  <span className="text-[11px] text-red-600">{row.error}</span>
                  <button type="button" onClick={() => void fetchPath(row.path)} className="text-[11px] text-neutral-500 underline hover:text-neutral-700">
                    重试
                  </button>
                </div>
              )}
              {row.expanded && row.truncated && (
                <p className="py-0.5 text-[11px] text-neutral-400" style={{ paddingLeft: `${row.depth * 16 + 30}px` }}>
                  内容过多，仅显示前 {DIRECTORY_ENTRIES_TRUNCATE_LIMIT} 项
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="border-t border-neutral-100 p-4">
          <p className="mb-3 truncate font-mono text-[11px] text-neutral-500" title={selected}>
            {selected ? `已选中：${selected}` : '点击目录名选中，点箭头展开'}
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">取消</button>
            <button
              disabled={!selected}
              onClick={() => {
                onSelect(selected);
                onClose();
              }}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 「浏览…」按钮 + 树形弹层的组合。三态门控（tree / native-picker / manual）
 * 由 page.tsx 的 DirectoryBrowseControl 统一判定（切片5），本组件只在
 * mode === 'tree' 时被渲染，自身不再做门控。
 */
export function DirectoryTreeBrowseButton({
  onSelect,
  onError,
  deviceId,
  disabled = false,
}: {
  onSelect: (path: string) => void;
  onError?: (message: string) => void;
  deviceId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={disabled || !deviceId}
        onClick={() => {
          onError?.('');
          setOpen(true);
        }}
        className="shrink-0 flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <FolderOpen size={12} /> 浏览
      </button>
      {open && deviceId && (
        <DirectoryTreePicker deviceId={deviceId} onSelect={onSelect} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
