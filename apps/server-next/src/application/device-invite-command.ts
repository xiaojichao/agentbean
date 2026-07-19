// 生成"添加设备"对话框使用的 daemon 连接命令。
// Device invite 命令由 server-next 直接维护，固定安装最新 CLI 后一次性连接并交接给
// Device Service。不再接受可把产品退回前台常驻模式的命令模板环境变量。
// profile slug 优先使用 explicit profileId，未提供时由 team.path 派生，保留多设备 profile 隔离能力。

const DEFAULT_PUBLIC_SERVER_URL = 'http://localhost:4000';

function slugifyProfile(source?: string | null): string {
  const slug = (source?.trim() || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}

export function resolveDeviceInviteServerUrl(): string {
  return process.env.AGENT_BEAN_PUBLIC_SERVER_URL ?? DEFAULT_PUBLIC_SERVER_URL;
}

export function buildDeviceInviteCommand(code: string, profileSource?: string | null, serverUrlOverride?: string | null): string {
  const serverUrl = serverUrlOverride ?? resolveDeviceInviteServerUrl();
  const profile = slugifyProfile(profileSource);
  return `npm install -g @agentbean/daemon@latest && agentbean device connect --invite-code ${shellArgument(code)} --server-url ${shellArgument(serverUrl)} --profile-id ${shellArgument(profile)}`;
}

export const DEVICE_SERVICE_OPERATION_COMMANDS = [
  { id: 'status', label: '查看状态', command: 'agentbean device status' },
  { id: 'logs', label: '查看实时日志', command: 'agentbean device logs --follow' },
  { id: 'restart', label: '重启服务', command: 'agentbean device restart' },
  { id: 'update', label: '升级 AgentBean', command: 'agentbean update' },
  { id: 'stop', label: '停止服务', command: 'agentbean device stop', advanced: true },
  { id: 'start', label: '启动服务', command: 'agentbean device start', advanced: true },
  { id: 'uninstall', label: '卸载服务', command: 'agentbean device uninstall', advanced: true },
] as const;

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
