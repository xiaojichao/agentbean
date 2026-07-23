'use client';

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Download, Eye, LoaderCircle, Paperclip, Play } from 'lucide-react';
import type { Artifact } from '@/lib/schema';
import { ArtifactViewer, artifactKind, formatFileSize } from './ArtifactViewer';

export interface ArtifactCardProps {
  artifact: Artifact;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  downloadUrl?: string | null;
  imagePrimaryAction?: 'preview' | 'download';
  renderTextPreview?: (content: string, artifact: Artifact) => ReactNode;
}

export function ArtifactCard({ artifact, previewUrl = null, thumbnailUrl = null, downloadUrl = null, imagePrimaryAction = 'preview', renderTextPreview }: ArtifactCardProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const viewerTriggerRef = useRef<HTMLElement | null>(null);
  const canPreview = Boolean(previewUrl);
  const imageArtifact = artifact.mimeType.startsWith('image/');
  const videoArtifact = artifact.mimeType.startsWith('video/');
  const previewProcessing = artifact.preview?.status === 'pending' || artifact.preview?.status === 'processing';
  const cardImageUrl = thumbnailUrl ?? (imageArtifact ? previewUrl : null);
  const labels = imageArtifact
    ? { preview: '预览图片', download: '下载图片' }
    : { preview: '预览文件', download: '下载文件' };

  const openViewer = (event: MouseEvent<HTMLButtonElement>) => {
    if (!canPreview) return;
    viewerTriggerRef.current = event.currentTarget;
    setViewerOpen(true);
  };
  const closeViewer = () => {
    setViewerOpen(false);
    viewerTriggerRef.current?.focus();
  };

  return (
    <>
      {imageArtifact ? (
        <div className="group relative block max-w-80">
          {cardImageUrl && imagePrimaryAction === 'download' && downloadUrl ? (
            <a href={downloadUrl} target="_blank" rel="noreferrer" className="block text-left" title={labels.download} aria-label={labels.download}>
              <img src={cardImageUrl} alt={artifact.filename} className="max-h-64 rounded-md border border-neutral-200 object-contain transition group-hover:border-neutral-400 group-focus-within:border-neutral-400" />
            </a>
          ) : cardImageUrl ? (
            <button type="button" onClick={openViewer} className="block text-left" title={labels.preview} aria-label={labels.preview}>
              <img src={cardImageUrl} alt={artifact.filename} className="max-h-64 rounded-md border border-neutral-200 object-contain transition group-hover:border-neutral-400 group-focus-within:border-neutral-400" />
            </button>
          ) : previewProcessing ? (
            <PreviewPlaceholder filename={artifact.filename} />
          ) : (
            <div className="inline-flex min-h-16 max-w-96 items-center gap-3 border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-700">
              <Paperclip size={15} />
              <span className="truncate">{artifact.filename}</span>
            </div>
          )}
          <ArtifactActions previewUrl={previewUrl} downloadUrl={downloadUrl} labels={labels} onPreview={openViewer} />
          <div className="mt-1 truncate text-xs text-neutral-500">{artifact.filename}</div>
        </div>
      ) : (
        <div className="group relative inline-flex min-h-16 max-w-96 overflow-hidden border border-neutral-300 bg-white text-xs text-neutral-700 transition hover:border-neutral-500 hover:bg-neutral-50">
          <button type="button" onClick={openViewer} disabled={!canPreview} className="inline-flex min-w-0 flex-1 items-center gap-3 px-3 py-2 pr-20 text-left disabled:cursor-default" title={canPreview ? labels.preview : '文件暂不可预览'} aria-label={canPreview ? labels.preview : undefined}>
            {thumbnailUrl ? (
              <span className="relative h-14 w-24 shrink-0 overflow-hidden bg-neutral-100">
                <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
                {videoArtifact && <Play size={18} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />}
              </span>
            ) : previewProcessing ? (
              <span className="flex h-14 w-24 shrink-0 items-center justify-center bg-neutral-100 text-neutral-400" aria-label="正在生成预览">
                <LoaderCircle size={18} className="animate-spin" />
              </span>
            ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-500 group-hover:bg-white">
              <Paperclip size={15} />
            </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-neutral-900">{artifact.filename}</span>
              <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{artifactKind(artifact).previewLabel} · {formatFileSize(artifact.sizeBytes)}</span>
              <span className="mt-0.5 block truncate text-[11px] text-neutral-400">{artifactKind(artifact).documentLabel}</span>
            </span>
          </button>
          <ArtifactActions previewUrl={previewUrl} downloadUrl={downloadUrl} labels={labels} onPreview={openViewer} className="right-2 top-1/2 -translate-y-1/2" />
        </div>
      )}
      {viewerOpen && previewUrl && <ArtifactViewer artifact={artifact} previewUrl={previewUrl} downloadUrl={downloadUrl} onClose={closeViewer} renderTextPreview={renderTextPreview} />}
    </>
  );
}

function PreviewPlaceholder({ filename }: { filename: string }) {
  return (
    <div className="flex min-h-16 min-w-48 items-center justify-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 text-xs text-neutral-500" aria-label={`${filename} 正在生成预览`}>
      <LoaderCircle size={15} className="animate-spin" />
      正在生成预览
    </div>
  );
}

function ArtifactActions({ previewUrl, downloadUrl, labels, onPreview, className = 'right-2 top-2' }: {
  previewUrl: string | null;
  downloadUrl: string | null;
  labels: { preview: string; download: string };
  onPreview: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  if (!previewUrl && !downloadUrl) return null;
  return (
    <div className={`absolute flex gap-1 ${className} opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100`}>
      {previewUrl && <button type="button" onClick={onPreview} className="flex h-7 w-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow-sm hover:bg-neutral-100" title={labels.preview} aria-label={labels.preview}>
        <Eye size={14} />
      </button>}
      {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow-sm hover:bg-neutral-100" title={labels.download} aria-label={labels.download}>
        <Download size={14} />
      </a>}
    </div>
  );
}
