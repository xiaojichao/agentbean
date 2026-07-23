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

    const previewAction = screen.getAllByRole('button', { name: '预览图片' })[1]!;
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
});
