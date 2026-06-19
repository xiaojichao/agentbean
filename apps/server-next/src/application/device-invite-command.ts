// 生成"添加设备"对话框使用的 daemon 连接命令。
// 移植自旧 apps/server 的 buildInviteCommand（apps/server/src/index.ts:45），适配 server-next 编译运行环境：
// - 优先使用 AGENT_BEAN_INVITE_COMMAND_TEMPLATE 模板（支持 {code}/{serverUrl}/{profile} 占位符）
// - 否则返回 production 默认命令 `npx @agentbean/daemon@latest ...`
//   （去掉旧版基于 process.cwd() 的本地 tsx 分支：server-next 从 dist 运行，相对路径判断不可靠，
//    本地调试可用 AGENT_BEAN_INVITE_COMMAND_TEMPLATE 覆盖）
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

export function buildDeviceInviteCommand(code: string, profileSource?: string | null): string {
  const serverUrl = resolveDeviceInviteServerUrl();
  const template = process.env.AGENT_BEAN_INVITE_COMMAND_TEMPLATE;
  const profile = slugifyProfile(profileSource);
  if (template) {
    return template
      .replaceAll('{code}', code)
      .replaceAll('{serverUrl}', serverUrl)
      .replaceAll('{profile}', profile);
  }
  const profileArg = profileSource ? ` --profile-id ${profile}` : '';
  return `npx @agentbean/daemon@latest --invite-code ${code} --server-url ${serverUrl}${profileArg}`;
}
