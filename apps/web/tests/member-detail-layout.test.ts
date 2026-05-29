import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const membersPage = readFileSync(new URL('../app/[networkPath]/members/page.tsx', import.meta.url), 'utf8');
const memberDetail = readFileSync(new URL('../components/member-detail.tsx', import.meta.url), 'utf8');

describe('member detail layout', () => {
  it('keeps the right panel centered when editable profile text wraps', () => {
    expect(membersPage).toContain('flex min-w-0 flex-1 flex-col');
    expect(membersPage).toContain('min-w-0 flex-1 overflow-y-auto p-6');
    expect(memberDetail).toContain('min-w-0 flex-1 whitespace-pre-wrap break-words');
  });
});
