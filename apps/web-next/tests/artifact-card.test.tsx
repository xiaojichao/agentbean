// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ArtifactCard } from '../components/artifact/ArtifactCard';
import type { Artifact } from '../lib/schema';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

const imageArtifact: Artifact = {
  id: 'artifact-image',
  filename: 'design.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  teamId: 'team-1',
};

describe('ArtifactCard', () => {
  test('lets a channel member preview an image and restores focus after Escape', () => {
    render(
      <ArtifactCard
        artifact={imageArtifact}
        previewUrl="https://example.test/artifacts/image/preview"
        downloadUrl="https://example.test/artifacts/image/download"
      />,
    );

    expect(document.querySelector('img')).toBeNull();
    const [preview] = screen.getAllByRole('button', { name: '预览图片' });
    expect(screen.getByRole('link', { name: '下载图片' }).getAttribute('href'))
      .toBe('https://example.test/artifacts/image/download');

    preview.focus();
    fireEvent.click(preview);
    expect(screen.getByRole('dialog', { name: 'design.png' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'design.png' })).toBeNull();
    expect(document.activeElement).toBe(preview);
  });

  test('restores focus to the preview action that actually opened the viewer', () => {
    render(<ArtifactCard artifact={imageArtifact} previewUrl="https://example.test/artifacts/image/preview" />);

    const previewAction = screen.getByRole('button', { name: '预览图片' });
    previewAction.focus();
    fireEvent.click(previewAction);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(document.activeElement).toBe(previewAction);
  });

  test('preserves a download-first image surface while keeping an explicit preview action', () => {
    render(
      <ArtifactCard
        artifact={imageArtifact}
        previewUrl="https://example.test/artifacts/image/preview"
        downloadUrl="https://example.test/artifacts/image/download"
        imagePrimaryAction="download"
      />,
    );

    expect(screen.getAllByRole('link', { name: '下载图片' })[0]?.getAttribute('href'))
      .toBe('https://example.test/artifacts/image/download');
    expect(screen.getByRole('button', { name: '预览图片' })).toBeTruthy();
  });

  test('renders fetched text through the caller-provided Markdown preview surface', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('# 设计说明'))) as typeof fetch;
    try {
      render(
        <ArtifactCard
          artifact={{ ...imageArtifact, filename: 'design.md', mimeType: 'text/markdown' }}
          previewUrl="https://example.test/artifacts/markdown/preview"
          renderTextPreview={(content) => <div>渲染结果：{content}</div>}
        />,
      );

      fireEvent.click(screen.getAllByRole('button', { name: '预览文件' })[0]!);
      await waitFor(() => expect(screen.getByText('渲染结果：# 设计说明')).toBeTruthy());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not expose a preview action when no preview URL is authorized', () => {
    render(<ArtifactCard artifact={{ ...imageArtifact, mimeType: 'application/octet-stream' }} downloadUrl="https://example.test/download" />);

    expect(screen.queryByRole('button', { name: '预览文件' })).toBeNull();
    expect(screen.getByRole('link', { name: '下载文件' }).getAttribute('href')).toBe('https://example.test/download');
  });

  test('keeps executable and unknown artifacts download-only even when a preview URL is present', () => {
    render(
      <>
        <ArtifactCard
          artifact={{ ...imageArtifact, id: 'html', filename: 'report.html', mimeType: 'text/html' }}
          previewUrl="https://example.test/artifacts/html/preview"
          downloadUrl="https://example.test/artifacts/html/download"
        />
        <ArtifactCard
          artifact={{ ...imageArtifact, id: 'binary', filename: 'readme.txt', mimeType: 'application/octet-stream' }}
          previewUrl="https://example.test/artifacts/binary/preview"
          downloadUrl="https://example.test/artifacts/binary/download"
        />
      </>,
    );

    expect(screen.queryByRole('button', { name: '预览文件' })).toBeNull();
    expect(screen.getAllByRole('link', { name: '下载文件' })).toHaveLength(2);
  });

  test('uses a static SVG derivative on the card while keeping original viewer access', () => {
    render(
      <ArtifactCard
        artifact={{ ...imageArtifact, filename: 'diagram.svg', mimeType: 'image/svg+xml' }}
        previewUrl="/preview"
        thumbnailUrl="/preview-derivative"
      />,
    );

    expect(document.querySelector('img')?.getAttribute('src')).toBe('/preview-derivative');
    fireEvent.click(screen.getAllByRole('button', { name: '预览图片' })[0]!);
    expect(screen.getByRole('dialog', { name: 'diagram.svg' }).querySelector('img')?.getAttribute('src'))
      .toBe('/preview');
  });

  test('normalizes MIME parameters before choosing the text viewer', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('safe text'))) as typeof fetch;
    try {
      render(
        <ArtifactCard
          artifact={{ ...imageArtifact, filename: 'notes.data', mimeType: 'text/plain; charset=utf-8' }}
          previewUrl="https://example.test/artifacts/text/preview"
        />,
      );

      fireEvent.click(screen.getAllByRole('button', { name: '预览文件' })[0]!);
      await waitFor(() => expect(screen.getByText('safe text')).toBeTruthy());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses a derivative thumbnail for a video while keeping the original preview action', () => {
    render(
      <ArtifactCard
        artifact={{
          ...imageArtifact,
          filename: 'demo.mp4',
          mimeType: 'video/mp4',
          preview: { status: 'ready', url: '/preview-derivative' },
        }}
        previewUrl="/preview"
        thumbnailUrl="/preview-derivative"
      />,
    );

    expect(document.querySelector('img[src="/preview-derivative"]')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '预览文件' })).toHaveLength(2);
  });

  test('shows a processing placeholder while the derivative is pending', () => {
    render(
      <ArtifactCard
        artifact={{
          ...imageArtifact,
          mimeType: 'video/mp4',
          preview: { status: 'processing' },
        }}
        previewUrl="/preview"
      />,
    );

    expect(screen.getByLabelText('正在生成预览')).toBeTruthy();
  });
});
