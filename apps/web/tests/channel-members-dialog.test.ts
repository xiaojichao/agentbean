import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatPage = readFileSync(new URL('../app/[networkPath]/chat/page.tsx', import.meta.url), 'utf8');

describe('channel members dialog', () => {
  it('hides add-member controls unless the viewer can manage channel members', () => {
    expect(chatPage).toContain('const canManageActiveChannelMembers = Boolean(');
    expect(chatPage).toContain("currentUser.role === 'admin'");
    expect(chatPage).toContain('activeChannelObj.createdBy === currentUser.id');
    expect(chatPage).toContain('currentNetwork?.ownerId === currentUser.id');
    expect(chatPage).toContain('canAddMembers={canManageActiveChannelMembers}');
    expect(chatPage).toContain('canAddMembers && showAdd');
    expect(chatPage).toContain('canAddMembers && (');
  });

  it('keeps long member lists scrollable inside the dialog', () => {
    expect(chatPage).toContain('max-h-[260px] overflow-y-auto rounded-lg border border-neutral-200 p-3 pr-2');
  });
});
