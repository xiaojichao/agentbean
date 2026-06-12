export const WEB_EVENTS = {
  auth: {
    login: 'auth:login',
    register: 'auth:register',
    whoami: 'auth:whoami',
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
  },
  member: {
    list: 'members:list',
    updateHuman: 'member:update-human',
  },
  device: {
    list: 'device:list',
    get: 'device:get',
    scan: 'device:scan',
    snapshot: 'devices:snapshot',
    status: 'device:status',
    runtimes: 'device:runtimes',
  },
  deviceInvite: {
    create: 'device-invite:create',
    complete: 'device-invite:complete',
  },
  agent: {
    subscribe: 'agents:subscribe',
    create: 'agent:create',
    publish: 'agent:publish',
    unpublish: 'agent:unpublish',
    snapshot: 'agents:snapshot',
    status: 'agent:status',
    discovered: 'agents:discovered',
    updateConfig: 'agent:update-config',
    delete: 'agent:delete',
    metrics: 'agent:metrics',
  },
  channel: {
    subscribe: 'channels:subscribe',
    create: 'channel:create',
    join: 'channel:join',
    history: 'channel:history',
    snapshot: 'channels:snapshot',
    message: 'channel:message',
    update: 'channel:update',
    addMember: 'channel:add-member',
    removeMember: 'channel:remove-member',
    addAgent: 'channel:add-agent',
    removeAgent: 'channel:remove-agent',
    members: 'channel:members',
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
  },
  dispatch: {
    cancel: 'dispatch:cancel',
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
  },
  agent: {
    registerBatch: 'agent:register-batch',
  },
  dispatch: {
    request: 'dispatch:request',
    cancel: 'dispatch:cancel',
    accepted: 'dispatch:accepted',
    result: 'dispatch:result',
    error: 'dispatch:error',
  },
} as const;
