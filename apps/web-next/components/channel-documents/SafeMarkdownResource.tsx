import type { ReactNode } from 'react';

export function collectSafeMarkdownReferenceDefinitions(body: string): {
  body: string;
  references: Map<string, string>;
} {
  const references = new Map<string, string>();
  const retainedLines: string[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      retainedLines.push(line);
      const closingFenceMatch = line.match(/^(?: {0,3})(`{3,}|~{3,})[ \t]*$/);
      if (closingFenceMatch?.[1]?.[0] === fence.character && closingFenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const fenceMatch = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1]![0] as '`' | '~',
        length: fenceMatch[1]!.length,
      };
      retainedLines.push(line);
      continue;
    }
    const match = line.match(/^\s{0,3}\[([^\]]+)]:\s*(<[^>\n]+>|[^\s]+)(?:\s+["'(].*)?$/);
    if (!match) {
      retainedLines.push(line);
      continue;
    }
    const rawTarget = match[2]!;
    references.set(
      match[1]!.trim().toLocaleLowerCase(),
      rawTarget.startsWith('<') && rawTarget.endsWith('>') ? rawTarget.slice(1, -1) : rawTarget,
    );
  }
  return { body: retainedLines.join('\n'), references };
}

export function SafeMarkdownResource({
  label,
  target,
  image,
  resolveInternalUrl,
}: {
  label: string;
  target: string;
  image: boolean;
  resolveInternalUrl: (path: string) => string | null;
}): ReactNode {
  if (target.startsWith('artifact-missing:')) {
    return <span role="status" className="text-amber-700">
      资源缺失：{decodeMissingPath(target)}
    </span>;
  }
  if (/^https?:\/\//i.test(target)) {
    return image
      ? <a href={target} target="_blank" rel="noreferrer">外部图片（默认不加载）：{label || target}</a>
      : <a href={target} target="_blank" rel="noreferrer">{label || target}</a>;
  }
  if (/^\/api\/teams\/[^/?#]+\/artifacts\/[^/?#]+\/(?:preview|download)$/.test(target)) {
    const url = resolveInternalUrl(target);
    if (!url) return <span role="status" className="text-amber-700">资源不可用：{label || target}</span>;
    return image
      ? <img src={url} alt={label} className="max-w-full rounded" />
      : <a href={url} target="_blank" rel="noreferrer">{label || target}</a>;
  }
  return <span role="status" className="text-amber-700">不安全或未固定的资源：{label || target}</span>;
}

function decodeMissingPath(target: string): string {
  try {
    return decodeURIComponent(target.slice('artifact-missing:'.length));
  } catch {
    return target.slice('artifact-missing:'.length);
  }
}
