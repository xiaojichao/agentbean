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

export function sanitizeTextArtifactFilename(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 240);
  return normalized || 'document.txt';
}

export function textArtifactMimeType(filename: string, fallbackMimeType?: string): string {
  if (fallbackMimeType) return fallbackMimeType.split(';', 1)[0]?.trim().toLowerCase() || 'text/plain';
  const extension = filename.toLowerCase().split('.').at(-1);
  const mimeTypes: Record<string, string> = {
    bat: 'text/x-msdos-batch', c: 'text/x-c', cc: 'text/x-c++src', cfg: 'text/plain',
    cmd: 'text/x-msdos-batch', conf: 'text/plain', cpp: 'text/x-c++src', cs: 'text/x-csharp',
    css: 'text/css', csv: 'text/csv', dart: 'text/x-dart', dockerfile: 'text/x-dockerfile',
    env: 'text/plain', ex: 'text/x-elixir', exs: 'text/x-elixir', gql: 'application/graphql',
    go: 'text/x-go', gradle: 'text/x-groovy', graphql: 'application/graphql', h: 'text/x-c',
    hcl: 'application/x-hcl', hpp: 'text/x-c++hdr', hs: 'text/x-haskell', html: 'text/html',
    ini: 'text/plain', java: 'text/x-java-source', js: 'application/javascript',
    jsx: 'application/javascript', json: 'application/json', kt: 'text/x-kotlin', less: 'text/less',
    lock: 'text/plain', log: 'text/plain', make: 'text/x-makefile', markdown: 'text/markdown',
    md: 'text/markdown', mdx: 'text/markdown', mjs: 'application/javascript',
    cjs: 'application/javascript', mk: 'text/x-makefile', pl: 'text/x-perl',
    php: 'application/x-httpd-php', properties: 'text/plain', proto: 'text/plain', ps1: 'text/plain',
    py: 'text/x-python', r: 'text/plain', rb: 'text/x-ruby', rst: 'text/x-rst', rs: 'text/x-rust',
    sass: 'text/x-sass', scss: 'text/x-scss', sh: 'application/x-sh', sql: 'application/sql',
    svelte: 'text/plain', swift: 'text/x-swift', tf: 'application/x-terraform', toml: 'application/toml',
    ts: 'application/typescript', tsx: 'application/typescript', txt: 'text/plain', vue: 'text/plain',
    xml: 'application/xml', xsd: 'application/xml', xsl: 'application/xslt+xml',
    yaml: 'application/yaml', yml: 'application/yaml', zsh: 'application/x-sh',
  };
  return extension ? mimeTypes[extension] ?? 'text/plain' : 'text/plain';
}
