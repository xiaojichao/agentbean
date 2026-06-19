import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const membersPage = readFileSync(new URL('../app/[teamPath]/members/page.tsx', import.meta.url), 'utf8');
const memberDetail = readFileSync(new URL('../components/member-detail.tsx', import.meta.url), 'utf8');

describe('member detail layout', () => {
  it('keeps the right panel centered when editable profile text wraps', () => {
    expect(membersPage).toContain('flex min-w-0 flex-1 flex-col');
    expect(membersPage).toContain('min-w-0 flex-1 overflow-y-auto p-6');
    expect(memberDetail).toContain('min-w-0 flex-1 whitespace-pre-wrap break-words');
  });

  it('routes lifecycle management to the device page instead of disabled member actions', () => {
    expect(memberDetail).toContain('在设备中管理');
    expect(memberDetail).toContain('运行时、团队发布和删除在设备页管理。');
    expect(memberDetail).not.toContain('重启 / 重置');
    expect(memberDetail).not.toContain('删除 Agent" danger disabled');
    expect(memberDetail).not.toContain('由设备 Daemon 自动管理');
    expect(memberDetail).not.toContain('ActionButton');
  });
});
