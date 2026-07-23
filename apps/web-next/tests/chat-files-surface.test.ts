import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const filesSurface = source.slice(
  source.indexOf('function ConversationFiles('),
  source.indexOf('function TaskDetailPanel('),
);

describe('chat files surface', () => {
  test('reuses the shared Artifact viewer instead of opening previews in a new tab', () => {
    expect(filesSurface).toContain('<ChatArtifactPreview');
    expect(filesSurface).not.toContain('target="_blank"');
    expect(filesSurface).not.toContain('title="预览文件"');
  });
});
