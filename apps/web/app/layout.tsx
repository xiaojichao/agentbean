import './globals.css';
import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { SocketProvider } from '@/components/socket-provider';

export const metadata: Metadata = {
  title: 'AgentBean',
  description: 'Your AI Agent Platform — manage, chat, and collaborate with AI agents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <SocketProvider>
          <AppShell>{children}</AppShell>
        </SocketProvider>
      </body>
    </html>
  );
}
