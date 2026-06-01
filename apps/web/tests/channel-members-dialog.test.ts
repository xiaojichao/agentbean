import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatPage = readFileSync(new URL('../app/[networkPath]/chat/page.tsx', import.meta.url), 'utf8');

describe('channel members dialog', () => {
  it('hides add-member controls unless the viewer can manage channel members', () => {
    expect(chatPage).toContain('const canManageActiveChannelMembers = Boolean(');
    expect(chatPage).toContain('activeChannelObj.createdBy === currentUser.id');
    expect(chatPage).not.toContain("currentUser.role === 'admin'");
    expect(chatPage).not.toContain('currentNetwork?.ownerId === currentUser.id');
    expect(chatPage).toContain('canAddMembers={canManageActiveChannelMembers}');
    expect(chatPage).toContain('canAddMembers && showAdd');
    expect(chatPage).toContain('canAddMembers && (');
  });

  it('keeps long member lists scrollable inside the dialog', () => {
    expect(chatPage).toContain('max-h-[260px] overflow-y-auto rounded-lg border border-neutral-200 p-3 pr-2');
  });

  it('opens member profiles from the channel member dialog', () => {
    expect(chatPage).toContain('onOpenMember={(member) => {');
    expect(chatPage).toContain('setShowMembers(false);');
    expect(chatPage).toContain('openProfile({ kind: member.kind, id: member.id });');
    expect(chatPage).toContain('<MemberGroup title="智能体" members={agentMembers} onOpen={onOpenMember}');
    expect(chatPage).toContain('onClick={() => onOpen(member)}');
  });
});
