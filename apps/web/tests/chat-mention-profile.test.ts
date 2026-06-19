import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatPage = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

describe('chat message mention profile links', () => {
  it('passes mention members into root and thread chat bubbles', () => {
    expect(chatPage).toContain('mentionMembers={mentionMembers}');
    expect(chatPage).toContain('mentionMembers: MentionProfileMember[];');
    expect(chatPage).toContain('mentionMembers?: MentionProfileMember[];');
  });

  it('opens the right profile panel when a rendered mention resolves to a member', () => {
    expect(chatPage).toContain('function resolveMentionTarget(name: string, members: MentionProfileMember[]): ProfileTarget | null');
    expect(chatPage).toContain('const target = resolveMentionTarget(token.slice(1), options.mentionMembers ?? []);');
    expect(chatPage).toContain('options.onOpenMention?.(target);');
    expect(chatPage).toContain('onOpenMention={onOpenProfile}');
  });

  it('keeps unresolved mentions visually marked without making them clickable', () => {
    expect(chatPage).toContain('<span key={`mention-${match.index}`} className="font-medium text-blue-600">{token}</span>');
  });
});
