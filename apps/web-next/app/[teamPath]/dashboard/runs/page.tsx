'use client';

import { RunsPanel } from '@/app/[teamPath]/settings/RunsPanel';
import { ConnectionBanner } from '@/components/connection-banner';

/**
 * System Admin Console — workspace run diagnostics section.
 * Only reachable by system admins via the Console shell gate.
 */
export default function AdminRunsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-smoke="admin-runs-page">
      <div className="flex h-14 shrink-0 items-center border-b border-neutral-200 px-4">
        <h1 className="text-sm font-semibold">执行记录诊断</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />
        <RunsPanel />
      </div>
    </div>
  );
}
