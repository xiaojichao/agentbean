import './globals.css';
import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { SocketProvider } from '@/components/socket-provider';

export const metadata: Metadata = {
  metadataBase: new URL('https://api.agentbean.dev'),
  title: 'AgentBean',
  description: '本地优先的人机协作团队平台：人类、本机 Agent、远程设备 Agent 在同一个 Team 里聊天、认领任务、交付文件。',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
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
