import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ADMIN_CONSOLE_NAV,
  ADMIN_LIST_DEFAULT_PAGE_SIZE,
  ADMIN_LIST_PAGE_SIZE_OPTIONS,
} from '../components/admin-console-panel';

describe('System Admin Console shell', () => {
  test('exposes console nav sections including PI, Memory, and run diagnostics', () => {
    expect(ADMIN_CONSOLE_NAV.map((item) => item.key)).toEqual([
      'teams',
      'users',
      'devices',
      'agents',
      'pi',
      'memory',
      'runs',
    ]);
    expect(ADMIN_CONSOLE_NAV.map((item) => item.label)).toEqual([
      '团队管理',
      '用户管理',
      '设备管理',
      'Agent 管理',
      'PI Agent 管理',
      'Memory 管理',
      '执行记录诊断',
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
    const piPage = readFileSync(
      new URL('../app/[teamPath]/dashboard/pi/page.tsx', import.meta.url),
      'utf8',
    );
    const memoryPage = readFileSync(
      new URL('../app/[teamPath]/dashboard/memory/page.tsx', import.meta.url),
      'utf8',
    );
    const runsPage = readFileSync(
      new URL('../app/[teamPath]/dashboard/runs/page.tsx', import.meta.url),
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

    expect(piPage).toContain('PiManagementPanel');
    expect(piPage).toContain('admin-pi-page');
    expect(piPage).not.toContain('AdminConsolePiPlaceholder');
    expect(panel).not.toContain('AdminConsolePiPlaceholder');
    expect(panel).not.toContain('admin-pi-placeholder');

    expect(memoryPage).toContain('MemoryGovernancePanel');
    expect(memoryPage).toContain('admin-memory-page');
    expect(runsPage).toContain('RunsPanel');
    expect(runsPage).toContain('admin-runs-page');

    expect(panel).toContain("section === 'teams'");
    expect(panel).toContain("section === 'users'");
    expect(panel).toContain("section === 'devices'");
    expect(panel).toContain("section === 'agents'");
    expect(panel).toContain('admin:list-users');
    expect(panel).toContain('admin:create-user');
    expect(panel).toContain('admin:update-user');
    expect(panel).toContain('admin:reset-user-password');
    expect(panel).toContain('admin:transfer-device-owner');
    expect(panel).toContain('data-smoke="admin-agent-row"');
    expect(panel).toContain('data-smoke="admin-create-user-open"');
    expect(panel).toContain('data-smoke="admin-create-user-no-team-warning"');
    expect(panel).toContain('data-smoke="admin-edit-user-open"');
    expect(panel).toContain('data-smoke="admin-reset-password-open"');
  });

  test('inventory lists request server-side pagination with default pageSize 20', () => {
    expect(ADMIN_LIST_DEFAULT_PAGE_SIZE).toBe(20);
    const panel = readFileSync(
      new URL('../components/admin-console-panel.tsx', import.meta.url),
      'utf8',
    );
    expect(panel).toContain('page: pageToLoad,');
    expect(panel).toContain('pageSize,');
    expect(panel).toContain('data-smoke="admin-list-pagination"');
    expect(panel).toContain('data-smoke="admin-list-prev"');
    expect(panel).toContain('data-smoke="admin-list-next"');
    expect(panel).toContain('ADMIN_LIST_DEFAULT_PAGE_SIZE');
  });

  test('inventory lists support keyword search q and pageSize 20/50/100', () => {
    expect(ADMIN_LIST_PAGE_SIZE_OPTIONS).toEqual([20, 50, 100]);
    const panel = readFileSync(
      new URL('../components/admin-console-panel.tsx', import.meta.url),
      'utf8',
    );
    expect(panel).toContain('listPayload.q = q');
    expect(panel).toContain('data-smoke="admin-list-search"');
    expect(panel).toContain('data-smoke="admin-list-search-submit"');
    expect(panel).toContain('data-smoke="admin-list-page-size"');
    expect(panel).toContain('ADMIN_LIST_PAGE_SIZE_OPTIONS');
    for (const size of ADMIN_LIST_PAGE_SIZE_OPTIONS) {
      expect(panel).toContain(String(size));
    }
  });
});
