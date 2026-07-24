export function initialChannelDocumentIds(artifactId: string): {
  documentId: string;
  revisionId: string;
} {
  const documentId = `channel-document:${artifactId}`;
  return {
    documentId,
    revisionId: `${documentId}:revision:1`,
  };
}

export function sanitizeMarkdownFilename(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 240);
  if (!normalized) return 'document.md';
  return /\.(?:md|markdown)$/i.test(normalized) ? normalized : `${normalized}.md`;
}

export function isMarkdownArtifact(
  artifact: { filename: string; mimeType: string },
): boolean {
  const mediaType = artifact.mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/markdown' || /\.(?:md|markdown)$/i.test(artifact.filename);
}
