'use client';

import { PiManagementPanel } from '@/app/[teamPath]/settings/PiManagementPanel';
import { ConnectionBanner } from '@/components/connection-banner';
import { useAgentBeanStore } from '@/lib/store';

/**
 * System Admin Console — PI Agent management section.
 * Hosts system-scope Provider Supply, Active PI Model, health, and System Knowledge.
 * Memory management and run diagnostics live on sibling Console sections.
 */
export default function AdminPiPage() {
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const isSystemAdmin = currentUser?.role === 'admin';

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-smoke="admin-pi-page">
      <div className="flex h-14 shrink-0 items-center border-b border-neutral-200 px-4">
        <h1 className="text-sm font-semibold">PI Agent 管理</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />
        <PiManagementPanel isSystemAdmin={Boolean(isSystemAdmin)} />
      </div>
    </div>
  );
}
