import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ADMIN_CONSOLE_NAV } from '../components/admin-console-panel';

describe('System Admin Console shell', () => {
  test('exposes five console nav sections including PI Agent management', () => {
    expect(ADMIN_CONSOLE_NAV.map((item) => item.key)).toEqual([
      'teams',
      'users',
      'devices',
      'agents',
      'pi',
    ]);
    expect(ADMIN_CONSOLE_NAV.map((item) => item.label)).toEqual([
      '团队管理',
      '用户管理',
      '设备管理',
      'Agent 管理',
      'PI Agent 管理',
    ]);
  });

  test('dashboard routes and middle nav are wired for section deep links', () => {
    const layout = readFileSync(
      new URL('../app/[teamPath]/dashboard/layout.tsx', import.meta.url),
      'utf8',
    );
    const indexPage = readFileSync(
      new URL('../app/[teamPath]/dashboard/page.tsx', import.meta.url),
      'utf8',
    );
    const teamsPage = readFileSync(
      new URL('../app/[teamPath]/dashboard/teams/page.tsx', import.meta.url),
      'utf8',
    );
    const panel = readFileSync(
      new URL('../components/admin-console-panel.tsx', import.meta.url),
      'utf8',
    );

    expect(layout).toContain('data-smoke="admin-dashboard-page"');
    expect(layout).toContain('data-smoke="admin-console-nav"');
    expect(layout).toContain('data-smoke={`admin-tab-${item.key}`}');
    expect(layout).toContain('admin-dashboard-forbidden');
    expect(layout).toContain("dashboard/${item.key}");

    expect(indexPage).toContain('dashboard/teams');
    expect(teamsPage).toContain('AdminConsolePanel');
    expect(teamsPage).toContain('section="teams"');

    expect(panel).toContain("section === 'teams'");
    expect(panel).toContain("section === 'users'");
    expect(panel).toContain("section === 'devices'");
    expect(panel).toContain("section === 'agents'");
    expect(panel).toContain('admin:list-users');
    expect(panel).toContain('admin:transfer-device-owner');
    expect(panel).toContain('data-smoke="admin-agent-row"');
  });
});
