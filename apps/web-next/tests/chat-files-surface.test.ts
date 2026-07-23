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

  test('ignores stale file responses after the channel or search query changes', () => {
    expect(source).toContain('const channelFilesRequestRevisionRef = useRef(0)');
    expect(source).toContain('if (requestRevision !== channelFilesRequestRevisionRef.current) return;');
    expect(source).toContain('if (requestRevision === channelFilesRequestRevisionRef.current)');
    expect(source).toMatch(/useEffect\(\(\) => \{\s+channelFilesRequestRevisionRef\.current \+= 1;\s+setChannelFiles\(\[\]\)/);
  });

  test('keeps directory navigation in the URL and exposes role filtering', () => {
    expect(source).toContain("searchParams.get('filePath')");
    expect(source).toContain("params.set('filePath', path)");
    expect(source).toContain("params.delete('filePath')");
    expect(filesSurface).toContain('按文件角色筛选');
    expect(filesSurface).toContain('directories.map');
  });
});
