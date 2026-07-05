import type { ChatMessage } from './schema';

export function stripEchoedDispatchHistory(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  const marker = normalized.search(/(?:^|\n)\s*#?\s*(?:user|assistant|system):\s+(?:[0-9A-Z]{10,}|system)\b/i);
  if (marker > 0) return normalized.slice(0, marker).trim();
  return normalized;
}

export function displayMessageBody(msg: ChatMessage): string {
  const body = stripEchoedDispatchHistory(msg.body);
  if (!msg.artifacts || msg.artifacts.length === 0) return body;
  const filenameByLower = new Map(msg.artifacts.map((artifact) => [artifact.filename.toLowerCase(), artifact.filename]));
  const fileExt = '(?:png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)';
  const localPathRe = new RegExp(`(?:file://)?(?:~|/Users/[^\\s)\\]}>,;:]+|/private/[^\\s)\\]}>,;:]+|/var/[^\\s)\\]}>,;:]+|/tmp/[^\\s)\\]}>,;:]+)[^\\s)\\]}>,;:]*?\\/([^/\\s)\\]}>,;:]+\\.${fileExt})`, 'gi');
  return body.replace(localPathRe, (match, filename: string) => {
    return filenameByLower.get(filename.toLowerCase()) ?? filename ?? match;
  });
}

export function plainTextForMessage(msg: ChatMessage): string {
  return markdownBodyToPlainText(displayMessageBody(msg));
}

export function markdownBodyToPlainText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      appendBlank(out);
      i += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      appendBlank(out);
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        out.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1;
      appendBlank(out);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      out.push(markdownInlineToPlainText(heading[2]!));
      i += 1;
      continue;
    }

    if (/^([-*_])\s*\1\s*\1\s*$/.test(trimmed)) {
      appendBlank(out);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      while (i < lines.length && /^>\s?/.test((lines[i] ?? '').trim())) {
        out.push(markdownInlineToPlainText((lines[i] ?? '').trim().replace(/^>\s?/, '')));
        i += 1;
      }
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      while (i < lines.length && /^[-*]\s+/.test((lines[i] ?? '').trim())) {
        out.push(markdownInlineToPlainText((lines[i] ?? '').trim().replace(/^[-*]\s+/, '')));
        i += 1;
      }
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? '').trim())) {
        out.push(markdownInlineToPlainText((lines[i] ?? '').trim().replace(/^\d+[.)]\s+/, '')));
        i += 1;
      }
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      while (i < lines.length && isMarkdownTableLine(lines[i] ?? '')) {
        const row = parseMarkdownTableRow(lines[i] ?? '').map(markdownInlineToPlainText);
        if (!row.every((cell) => /^:?-{3,}:?$/.test(cell))) out.push(row.join('\t'));
        i += 1;
      }
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^```/.test((lines[i] ?? '').trim()) &&
      !/^(#{1,4})\s+/.test((lines[i] ?? '').trim()) &&
      !/^([-*_])\s*\1\s*\1\s*$/.test((lines[i] ?? '').trim()) &&
      !/^>\s?/.test((lines[i] ?? '').trim()) &&
      !/^[-*]\s+/.test((lines[i] ?? '').trim()) &&
      !/^\d+[.)]\s+/.test((lines[i] ?? '').trim()) &&
      !isMarkdownTableStart(lines, i)
    ) {
      paragraph.push(markdownInlineToPlainText((lines[i] ?? '').trim()));
      i += 1;
    }
    out.push(paragraph.join('\n'));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function markdownInlineToPlainText(text: string): string {
  let next = text;
  let previous: string;
  do {
    previous = next;
    next = next
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1');
  } while (next !== previous);
  return next;
}

function appendBlank(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').filter((cell) => cell.trim()).length >= 2;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const separator = lines[index + 1] ?? '';
  return isMarkdownTableLine(header) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator);
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}
