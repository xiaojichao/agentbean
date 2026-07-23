'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  readChannelDocumentDraft,
  removeChannelDocumentDraft,
  writeChannelDocumentDraft,
  type ChannelDocumentDraft,
  type ChannelDocumentDraftIdentity,
} from '@/lib/channel-document-drafts';

type Mode = 'edit' | 'preview' | 'split';

export interface MarkdownDocumentSnapshot {
  content: string;
  filename: string;
  revisionId: string;
}

export type MarkdownDocumentSaveResult =
  | { ok: true; revisionId: string }
  | { ok: false; conflict: true; message: string };

export interface MarkdownDocumentEditorProps {
  draftIdentity?: ChannelDocumentDraftIdentity;
  filename: string;
  initialContent: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  onSave: (content: string, filename: string, baseRevisionId?: string) => Promise<void | MarkdownDocumentSaveResult>;
  onLoadLatest?: () => Promise<MarkdownDocumentSnapshot>;
  onClose?: () => void;
  renderPreview: (content: string) => ReactNode;
}

/** 安全的源码编辑器：预览由 React 节点渲染，不把原始 HTML 交给 innerHTML。 */
export function MarkdownDocumentEditor({
  draftIdentity: initialDraftIdentity,
  filename: initialFilename,
  initialContent,
  readOnly = false,
  readOnlyReason,
  onSave,
  onLoadLatest,
  onClose,
  renderPreview,
}: MarkdownDocumentEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [filename, setFilename] = useState(initialFilename);
  const [baselineContent, setBaselineContent] = useState(initialContent);
  const [baselineFilename, setBaselineFilename] = useState(initialFilename);
  const [currentBaseRevisionId, setCurrentBaseRevisionId] = useState(initialDraftIdentity?.baseRevisionId);
  const [mode, setMode] = useState<Mode>('split');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<ChannelDocumentDraft | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [latest, setLatest] = useState<MarkdownDocumentSnapshot | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [manualMergeStart, setManualMergeStart] = useState<{
    content: string;
    baseRevisionId: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = content !== baselineContent || filename !== baselineFilename;
  const manualMergeChanged = manualMergeStart ? content !== manualMergeStart.content : false;
  const draftIdentity: ChannelDocumentDraftIdentity | null =
    initialDraftIdentity && currentBaseRevisionId
      ? { ...initialDraftIdentity, baseRevisionId: currentBaseRevisionId }
      : null;

  useEffect(() => {
    setContent(initialContent);
    setFilename(initialFilename);
    setBaselineContent(initialContent);
    setBaselineFilename(initialFilename);
    setCurrentBaseRevisionId(initialDraftIdentity?.baseRevisionId);
    setConflict(null);
    setLatest(null);
    setManualMergeStart(null);
    if (typeof window === 'undefined' || !initialDraftIdentity) {
      setRecoveryDraft(null);
      return;
    }
    const recovered = readChannelDocumentDraft(
      window.localStorage,
      initialDraftIdentity,
    );
    setRecoveryDraft(
      recovered && (recovered.content !== initialContent || recovered.filename !== initialFilename)
        ? recovered
        : null,
    );
  }, [
    initialContent,
    initialDraftIdentity?.baseRevisionId,
    initialDraftIdentity?.documentId,
    initialDraftIdentity?.teamId,
    initialDraftIdentity?.userId,
    initialFilename,
  ]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => {
    if (!dirty || !draftIdentity || typeof window === 'undefined') return;
    writeChannelDocumentDraft(window.localStorage, draftIdentity, {
      content,
      filename,
      updatedAt: Date.now(),
    });
  }, [content, dirty, draftIdentity?.baseRevisionId, draftIdentity?.documentId, draftIdentity?.teamId, draftIdentity?.userId, filename]);

  const insert = (before: string, after = before) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setContent(`${content.slice(0, start)}${before}${content.slice(start, end)}${after}${content.slice(end)}`);
  };
  const save = async () => {
    if (readOnly || saving || !dirty) return;
    if (conflict && (!manualMergeStart || !manualMergeChanged)) {
      setSaveError(manualMergeStart
        ? '请先在编辑区完成手工合并，再保存'
        : '请先查看最新版并选择继续手工合并');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const baseRevisionId = manualMergeStart?.baseRevisionId ?? currentBaseRevisionId;
      const result = baseRevisionId
        ? await onSave(content, filename, baseRevisionId)
        : await onSave(content, filename);
      if (result && !result.ok) {
        setConflict(result.message);
        setLatest(null);
        setManualMergeStart(null);
        return;
      }
      if (draftIdentity && typeof window !== 'undefined') {
        removeChannelDocumentDraft(window.localStorage, draftIdentity);
      }
      setBaselineContent(content);
      setBaselineFilename(filename);
      if (result?.ok) setCurrentBaseRevisionId(result.revisionId);
      setRecoveryDraft(null);
      setConflict(null);
      setLatest(null);
      setManualMergeStart(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };
  const copyDraft = async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  };

  return <section className="flex min-h-0 flex-col gap-3" aria-label="Markdown 文档编辑器">
    <header className="flex flex-wrap items-center gap-2">
      <input value={filename} disabled={readOnly || saving} onChange={(event) => setFilename(event.target.value)} aria-label="文档标题" className="rounded border px-2 py-1 text-sm" />
      <div className="flex gap-1" role="toolbar" aria-label="Markdown 工具栏">
        <button type="button" onClick={() => insert('**')} disabled={readOnly || saving} title="粗体">B</button>
        <button type="button" onClick={() => insert('*')} disabled={readOnly || saving} title="斜体">I</button>
        <button type="button" onClick={() => insert('[', '](https://)')} disabled={readOnly || saving} title="链接">链接</button>
        <button type="button" onClick={() => insert('- ')} disabled={readOnly || saving} title="列表">列表</button>
        <button type="button" onClick={() => insert('> ')} disabled={readOnly || saving} title="引用">引用</button>
        <button type="button" onClick={() => insert('`')} disabled={readOnly || saving} title="代码">代码</button>
      </div>
      {(['edit', 'preview', 'split'] as Mode[]).map((value) => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}>{value}</button>)}
      <button
        type="button"
        disabled={readOnly || saving || !dirty || Boolean(conflict && (!manualMergeStart || !manualMergeChanged))}
        onClick={() => void save()}
      >{saving ? '保存中…' : '保存'}</button>
      {onClose && <button type="button" onClick={() => { if (!dirty || window.confirm('有未保存的修改，确定关闭吗？')) onClose(); }}>关闭</button>}
      {readOnly && <span className="text-xs text-neutral-500">{readOnlyReason ?? '只读'}</span>}
    </header>
    {recoveryDraft && <div role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p>检测到未提交的本地草稿</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => {
          setContent(recoveryDraft.content);
          setFilename(recoveryDraft.filename);
        }}>恢复草稿</button>
        <button type="button" onClick={() => {
          if (draftIdentity && typeof window !== 'undefined') removeChannelDocumentDraft(window.localStorage, draftIdentity);
          setContent(baselineContent);
          setFilename(baselineFilename);
          setRecoveryDraft(null);
        }}>丢弃草稿</button>
      </div>
    </div>}
    {conflict && <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <p>{conflict}</p>
      <p className="mt-1 text-xs">你的完整草稿仍保存在本机。系统不会强制覆盖或创建分叉版本。</p>
      {manualMergeStart && <p className="mt-1 text-xs font-medium">请对照服务器最新版修改编辑区内容；完成实际合并后才能保存。</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={loadingLatest || !onLoadLatest || Boolean(manualMergeStart)} onClick={() => {
          if (!onLoadLatest) return;
          setLoadingLatest(true);
          void onLoadLatest()
            .then(setLatest)
            .catch((error) => setSaveError(error instanceof Error ? error.message : '最新版加载失败'))
            .finally(() => setLoadingLatest(false));
        }}>{loadingLatest ? '加载中…' : '查看最新版'}</button>
        <button type="button" onClick={() => void copyDraft()}>复制草稿</button>
        <button type="button" disabled={!latest || Boolean(manualMergeStart)} onClick={() => {
          if (!latest) return;
          setManualMergeStart({
            content,
            baseRevisionId: latest.revisionId,
          });
          setSaveError(null);
        }}>继续手工合并</button>
        <button type="button" onClick={() => {
          setConflict(null);
          setLatest(null);
          setManualMergeStart(null);
          setSaveError(null);
        }}>取消</button>
      </div>
      {latest && <div className="mt-3 rounded border border-amber-200 bg-white p-2">
        <p className="mb-1 text-xs font-medium">服务器最新版（只读）</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{latest.content}</pre>
      </div>}
    </div>}
    {saveError && <div role="alert" className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{saveError}</div>}
    <div className={`grid min-h-0 flex-1 gap-3 ${mode === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
      {mode !== 'preview' && <textarea ref={textareaRef} data-channel-document-editor value={content} disabled={readOnly || saving} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!readOnly) void save(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); insert('**'); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); insert('*'); } }} className="min-h-64 w-full resize-none rounded border p-3 font-mono text-sm" />}
      {mode !== 'edit' && <article className="prose min-h-64 max-w-none overflow-y-auto rounded border p-3">{renderPreview(content)}</article>}
    </div>
  </section>;
}
