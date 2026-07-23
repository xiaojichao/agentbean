'use client';

import { useEffect, useMemo, useState } from 'react';

type Mode = 'edit' | 'preview' | 'split';

export interface MarkdownDocumentEditorProps {
  filename: string;
  initialContent: string;
  readOnly?: boolean;
  onSave: (content: string, filename: string) => Promise<void>;
  onClose?: () => void;
}

/** 安全的源码编辑器：首版保留 Markdown 源码，不把原始 HTML 交给 innerHTML。 */
export function MarkdownDocumentEditor({ filename: initialFilename, initialContent, readOnly = false, onSave, onClose }: MarkdownDocumentEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [filename, setFilename] = useState(initialFilename);
  const [mode, setMode] = useState<Mode>('split');
  const [saving, setSaving] = useState(false);
  const dirty = content !== initialContent || filename !== initialFilename;

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const preview = useMemo(() => safeMarkdownPreview(content), [content]);
  const insert = (before: string, after = before) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-channel-document-editor]');
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setContent(`${content.slice(0, start)}${before}${content.slice(start, end)}${after}${content.slice(end)}`);
  };
  const save = async () => { setSaving(true); try { await onSave(content, filename); } finally { setSaving(false); } };

  return <section className="flex min-h-0 flex-col gap-3" aria-label="Markdown 文档编辑器">
    <header className="flex flex-wrap items-center gap-2">
      <input value={filename} disabled={readOnly} onChange={(event) => setFilename(event.target.value)} aria-label="文档标题" className="rounded border px-2 py-1 text-sm" />
      <div className="flex gap-1" role="toolbar" aria-label="Markdown 工具栏">
        <button type="button" onClick={() => insert('**')} disabled={readOnly} title="粗体">B</button>
        <button type="button" onClick={() => insert('*')} disabled={readOnly} title="斜体">I</button>
        <button type="button" onClick={() => insert('[', '](https://)')} disabled={readOnly} title="链接">链接</button>
        <button type="button" onClick={() => insert('- ')} disabled={readOnly} title="列表">列表</button>
        <button type="button" onClick={() => insert('> ')} disabled={readOnly} title="引用">引用</button>
        <button type="button" onClick={() => insert('`')} disabled={readOnly} title="代码">代码</button>
      </div>
      {(['edit', 'preview', 'split'] as Mode[]).map((value) => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}>{value}</button>)}
      <button type="button" disabled={readOnly || saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      {onClose && <button type="button" onClick={() => { if (!dirty || window.confirm('有未保存的修改，确定关闭吗？')) onClose(); }}>关闭</button>}
      {readOnly && <span className="text-xs text-neutral-500">频道已归档，只读</span>}
    </header>
    <div className={`grid min-h-0 flex-1 gap-3 ${mode === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
      {mode !== 'preview' && <textarea data-channel-document-editor value={content} disabled={readOnly} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!readOnly) void save(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); insert('**'); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); insert('*'); } }} className="min-h-64 w-full resize-none rounded border p-3 font-mono text-sm" />}
      {mode !== 'edit' && <article className="prose min-h-64 max-w-none rounded border p-3 whitespace-pre-wrap">{preview}</article>}
    </div>
  </section>;
}

function safeMarkdownPreview(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}
