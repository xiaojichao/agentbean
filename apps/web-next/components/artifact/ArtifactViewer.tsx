'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, X } from 'lucide-react';
import { normalizeArtifactMimeType } from '@agentbean/contracts';
import type { Artifact } from '@/lib/schema';

export interface ArtifactViewerProps {
  artifact: Artifact;
  previewUrl: string | null;
  downloadUrl?: string | null;
  onClose: () => void;
  renderTextPreview?: (content: string, artifact: Artifact) => ReactNode;
}

export function ArtifactViewer({ artifact, previewUrl, downloadUrl, onClose, renderTextPreview }: ArtifactViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inlineText = isInlineTextArtifact(artifact);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!previewUrl || !inlineText) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(previewUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(formatArtifactTextPreview(artifact, text));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '预览失败');
      });
    return () => { cancelled = true; };
  }, [artifact, inlineText, previewUrl]);

  if (!previewUrl) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={artifact.filename}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col bg-neutral-950/65"
    >
      <div className="flex h-14 shrink-0 items-center gap-3 bg-white px-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-neutral-900">{artifact.filename}</div>
          <div className="text-[11px] text-neutral-400">{artifactKind(artifact).previewLabel} · {formatFileSize(artifact.sizeBytes)}</div>
        </div>
        {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50" title="下载">
          <Download size={14} />
          下载
        </a>}
        <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" title="关闭预览" aria-label="关闭预览">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {artifact.mimeType.startsWith('image/') ? (
          <img src={previewUrl} alt={artifact.filename} className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-2xl" />
        ) : inlineText ? (
          <div className="h-full w-full max-w-5xl overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
            {error ? (
              <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>
            ) : content === null ? (
              <div className="text-sm text-neutral-400">正在加载预览...</div>
            ) : renderTextPreview ? renderTextPreview(content, artifact) : (
              <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-700">{content}</pre>
            )}
          </div>
        ) : (
          <iframe src={previewUrl} title={artifact.filename} className="h-full w-full max-w-5xl rounded-lg border-0 bg-white shadow-2xl" />
        )}
      </div>
    </div>
  );
}

export function isMarkdownArtifact(artifact: Artifact): boolean {
  const name = artifact.filename.toLowerCase();
  return artifact.mimeType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown');
}

export function isInlineTextArtifact(artifact: Artifact): boolean {
  const name = artifact.filename.toLowerCase();
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  return isMarkdownArtifact(artifact)
    || mimeType === 'text/plain'
    || mimeType === 'text/csv'
    || mimeType === 'application/json'
    || name.endsWith('.txt')
    || name.endsWith('.json')
    || name.endsWith('.csv');
}

export function formatArtifactTextPreview(artifact: Artifact, text: string): string {
  if (artifact.mimeType !== 'application/json' && !artifact.filename.toLowerCase().endsWith('.json')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function artifactKind(artifact: Artifact): { previewLabel: string; documentLabel: string } {
  const name = artifact.filename.toLowerCase();
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  if (isMarkdownArtifact(artifact)) return { previewLabel: 'Markdown 预览', documentLabel: 'Markdown 文档' };
  if (mimeType === 'text/plain' || name.endsWith('.txt')) return { previewLabel: '文本预览', documentLabel: '文本文件' };
  if (mimeType === 'text/csv' || name.endsWith('.csv')) return { previewLabel: 'CSV 预览', documentLabel: 'CSV 文件' };
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return { previewLabel: 'PDF 预览', documentLabel: 'PDF 文件' };
  if (name.endsWith('.json') || mimeType === 'application/json') return { previewLabel: 'JSON 预览', documentLabel: 'JSON 文件' };
  return { previewLabel: '文件预览', documentLabel: '附件文件' };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}
