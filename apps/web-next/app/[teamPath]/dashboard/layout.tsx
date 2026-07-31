'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { Activity, Bot, Database, Globe, Monitor, Sparkles, Terminal, Users } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { ADMIN_CONSOLE_NAV, type AdminConsoleNavKey } from '@/components/admin-console-panel';
import { useAgentBeanStore } from '@/lib/store';

const NAV_ICONS: Record<AdminConsoleNavKey, React.ReactNode> = {
  teams: <Globe size={14} />,
  users: <Users size={14} />,
  devices: <Monitor size={14} />,
  agents: <Bot size={14} />,
  pi: <Sparkles size={14} />,
  memory: <Database size={14} />,
  runs: <Terminal size={14} />,
  'pi-auto': <Activity size={14} />,
};

function sectionFromPath(pathname: string): AdminConsoleNavKey | null {
  const match = pathname.match(/\/dashboard(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const key = match[1] ?? 'teams';
  if (
    key === 'teams'
    || key === 'users'
    || key === 'devices'
    || key === 'agents'
    || key === 'pi'
    || key === 'pi-auto'
    || key === 'memory'
    || key === 'runs'
  ) {
    return key;
  }
  return null;
}

export default function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const teamPath = params.teamPath as string;
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const section = sectionFromPath(pathname) ?? 'teams';

  if (!currentUser || currentUser.role !== 'admin') {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">仪表盘</div>
        <div className="flex-1 overflow-y-auto p-6" data-smoke="admin-dashboard-forbidden">
          <ConnectionBanner />
          <div className="text-sm text-red-600">仅管理员可访问此页面。</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-smoke="admin-dashboard-page"
      data-admin-tab={section}
    >
      <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">
        管理仪表盘
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Middle nav — System Admin Console */}
        <nav
          className="flex w-48 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 p-2"
          data-smoke="admin-console-nav"
        >
          <div className="mb-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            系统管理
          </div>
          {ADMIN_CONSOLE_NAV.map((item) => {
            const href = `/${teamPath}/dashboard/${item.key}`;
            const selected = section === item.key;
            return (
              <Link
                key={item.key}
                href={href}
                className={`mb-0.5 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors ${
                  selected
                    ? 'bg-white font-medium text-neutral-900 shadow-sm'
                    : 'text-neutral-600 hover:bg-white/70 hover:text-neutral-900'
                }`}
                data-smoke={`admin-tab-${item.key}`}
                data-admin-tab={item.key}
                data-admin-selected={selected ? 'true' : 'false'}
              >
                {NAV_ICONS[item.key]}
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
