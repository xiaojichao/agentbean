'use client';

import { MemoryGovernancePanel } from '@/app/[teamPath]/settings/MemoryGovernancePanel';
import { ConnectionBanner } from '@/components/connection-banner';

/**
 * System Admin Console — Memory management section.
 * Hosts collaborative Memory governance (Formal / candidates / grants / capsules / projections).
 * Only reachable by system admins via the Console shell gate.
 */
export default function AdminMemoryPage() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-smoke="admin-memory-page">
      <div className="flex h-14 shrink-0 items-center border-b border-neutral-200 px-4">
        <h1 className="text-sm font-semibold">Memory 管理</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />
        <MemoryGovernancePanel />
      </div>
    </div>
  );
}
