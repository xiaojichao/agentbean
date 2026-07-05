export const WEB_EVENTS = {
  auth: {
    login: 'auth:login',
    register: 'auth:register',
    whoami: 'auth:whoami',
    changePassword: 'auth:change-password',
  },
  team: {
    list: 'team:list',
    create: 'team:create',
    switch: 'team:switch',
    snapshot: 'teams:snapshot',
    update: 'team:update',
    delete: 'team:delete',
  },
  join: {
    create: 'join:create',
    validate: 'join:validate',
    list: 'join:list',
    revoke: 'join:revoke',
  },
  member: {
    list: 'members:list',
    updateHuman: 'member:update-human',
    updateRole: 'member:update-role',
    remove: 'member:remove',
    transferOwner: 'member:transfer-owner',
  },
  device: {
    list: 'device:list',
    get: 'device:get',
    scan: 'device:scan',
    snapshot: 'devices:snapshot',
    status: 'device:status',
    runtimes: 'device:runtimes',
    agentsList: 'device:agents:list',
    rename: 'device:rename',
    delete: 'device:delete',
    selectDirectory: 'device:select-directory',
  },
  deviceInvite: {
    create: 'device-invite:create',
    complete: 'device-invite:complete',
  },
  agent: {
    subscribe: 'agents:subscribe',
    create: 'agent:create',
    // 切换 Agent 在 primary team 上的可见性（隐藏 = 移出当前团队成员页）
    setVisibility: 'agent:set-visibility',
    snapshot: 'agents:snapshot',
    status: 'agent:status',
    discovered: 'agents:discovered',
    updateConfig: 'agent:update-config',
    delete: 'agent:delete',
    metrics: 'agent:metrics',
  },
  admin: {
    listTeams: 'admin:list-teams',
    listNetworks: 'admin:list-networks',
    listUsers: 'admin:list-users',
    listDevices: 'admin:list-devices',
    listAgents: 'admin:list-agents',
    deleteTeam: 'admin:delete-team',
    deleteNetwork: 'admin:delete-network',
    deleteUser: 'admin:delete-user',
    deleteAgent: 'admin:delete-agent',
    transferDeviceOwner: 'admin:transfer-device-owner',
  },
  channel: {
    subscribe: 'channels:subscribe',
    create: 'channel:create',
    join: 'channel:join',
    leave: 'channel:leave',
    history: 'channel:history',
    snapshot: 'channels:snapshot',
    message: 'channel:message',
    update: 'channel:update',
    addMember: 'channel:add-member',
    removeMember: 'channel:remove-member',
    addAgent: 'channel:add-agent',
    removeAgent: 'channel:remove-agent',
    members: 'channel:members',
    archive: 'channel:archive',
    delete: 'channel:delete',
  },
  dm: {
    start: 'dm:start',
    list: 'dm:list',
    snapshot: 'dms:snapshot',
  },
  message: {
    send: 'message:send',
    dispatchStatus: 'message:dispatch-status',
    search: 'message:search',
    context: 'message:context',
    react: 'message:react',
    save: 'message:save',
    listSaved: 'message:list-saved',
    pin: 'message:pin',
    listPinned: 'message:list-pinned',
    delete: 'message:delete',
    pinnedUpdated: 'message:pinned-updated',
    convertToTask: 'message:convert-to-task',
  },
  dispatch: {
    cancel: 'dispatch:cancel',
    cancelChannel: 'dispatch:cancel-channel',
  },
  task: {
    list: 'task:list',
    create: 'task:create',
    update: 'task:update',
    delete: 'task:delete',
    reorder: 'task:reorder',
    snapshot: 'tasks:snapshot',
    updated: 'task:updated',
  },
} as const;

export const AGENT_EVENTS = {
  deviceInvite: {
    wait: 'device-invite:wait',
    credentials: 'device-invite:credentials',
  },
  device: {
    hello: 'device:hello',
    runtimes: 'device:runtimes',
    scanRequested: 'device:scan-requested',
    selectDirectoryRequested: 'device:select-directory-requested',
    // 服务端→daemon 单向通知：该设备已被删除，daemon 应回收重连并退出进程。
    removed: 'device:removed',
  },
  agent: {
    registerBatch: 'agent:register-batch',
    reportCustomSkills: 'agent:report-custom-skills',
  },
  dispatch: {
    request: 'dispatch:request',
    cancel: 'dispatch:cancel',
    accepted: 'dispatch:accepted',
    result: 'dispatch:result',
    error: 'dispatch:error',
  },
} as const;

export interface ScanRequestCustomAgent {
  id: string;
  adapterKind: string;
  cwd?: string;
}

export interface ScanRequest {
  requestId: string;
  deviceId: string;
  customAgents?: ScanRequestCustomAgent[];
}
