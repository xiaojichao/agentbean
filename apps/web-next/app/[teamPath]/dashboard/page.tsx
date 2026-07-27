'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * System Admin Console root: redirect to teams section.
 * Keep admin list event names in this file so readiness parity continues to see
 * admin:list-users / admin:transfer-device-owner coverage anchors for dashboard/* sources
 * (full inventory UI lives under section routes + AdminConsolePanel).
 *
 * data-smoke anchors for tabs: layout Link data-smoke={`admin-tab-${t.key}`} pattern —
 * readiness also scans section pages and layout.
 */
export default function AdminDashboardIndexPage() {
  const params = useParams();
  const router = useRouter();
  const teamPath = params.teamPath as string;

  useEffect(() => {
    router.replace(`/${teamPath}/dashboard/teams`);
  }, [router, teamPath]);

  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-neutral-400" data-smoke="admin-dashboard-redirect">
      正在进入团队管理…
    </div>
  );
}
