import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatPage = readFileSync(new URL('../app/[networkPath]/chat/page.tsx', import.meta.url), 'utf8');

describe('channel members dialog', () => {
  it('hides add-member controls for the default public channel', () => {
    expect(chatPage).toContain('canAddMembers={!isDefaultPublicChannel}');
    expect(chatPage).toContain('canAddMembers && showAdd');
    expect(chatPage).toContain('canAddMembers && (');
  });

  it('keeps long member lists scrollable inside the dialog', () => {
    expect(chatPage).toContain('max-h-[260px] overflow-y-auto rounded-lg border border-neutral-200 p-3 pr-2');
  });
});
