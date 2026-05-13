'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { ConnectionBanner } from '@/components/connection-banner';
import { authEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

const MARKETING_ROUTES = ['/', '/login', '/signup', '/register'];
const RESERVED_PREFIXES = ['/join/', '/device-login/'];

function isNetworkRoute(pathname: string): boolean {
  if (MARKETING_ROUTES.includes(pathname)) return false;
  for (const prefix of RESERVED_PREFIXES) {
    if (pathname.startsWith(prefix)) return false;
  }
  return pathname.split('/').length >= 2 && pathname !== '/';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const authToken = useAgentBeanStore((s) => s.authToken);
  const conn = useAgentBeanStore((s) => s.conn);
  const pathname = usePathname();
  const router = useRouter();

  // Hydrate auth token from localStorage
  useEffect(() => {
    const token = localStorage.getItem('agentbean.token');
    if (token) {
      useAgentBeanStore.getState().setAuthToken(token);
    }
    setHydrated(true);
  }, []);

  // Fetch current user info when connected with a token
  useEffect(() => {
    if (!authToken || conn !== 'open') return;
    authEvents().whoami().then((res) => {
      if (res.ok && res.user) {
        useAgentBeanStore.getState().setCurrentUser(res.user);
      } else if (res.error) {
        localStorage.removeItem('agentbean.token');
        useAgentBeanStore.getState().setAuthToken(null);
        useAgentBeanStore.getState().setCurrentUser(null);
      }
    });
  }, [authToken, conn]);

  const marketing = MARKETING_ROUTES.includes(pathname);
  const networked = isNetworkRoute(pathname);

  useEffect(() => {
    if (!hydrated) return;
    if (authToken && marketing) {
      const savedNp = localStorage.getItem('agentbean.networkPath');
      const s = useAgentBeanStore.getState();
      const net = s.networks.find((n) => n.id === s.currentNetworkId);
      router.replace(`/${savedNp || net?.path || 'default'}/chat`);
    }
    if (!authToken && networked) {
      router.replace('/');
    }
  }, [hydrated, authToken, marketing, networked, router]);

  if (!hydrated) {
    return <div className="min-h-screen bg-neutral-950" />;
  }

  if (authToken && networked) {
    return (
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          <ConnectionBanner />
          <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
        </main>
      </div>
    );
  }

  return <>{children}</>;
}
