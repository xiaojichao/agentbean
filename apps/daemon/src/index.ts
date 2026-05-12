import { parseArgs } from 'node:util';
import { loadConfig, loadDeviceConfig } from './config.js';
import { createConnection } from './connection.js';
import { createDeviceDaemon } from './device-daemon.js';
import { AgentInstance } from './agent-instance.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { HermesAdapter } from './adapters/hermes.js';
import type { CliAdapter } from './adapters/adapter.js';
import type { AgentConfigEntry, DeviceConfig } from './config.js';
import { logger } from './log.js';
import { scanRuntimes, scanAgentOSAgents, scanLocalAgents, getDeviceId } from './scanner.js';
import { loadAuth, saveAuth } from './auth-store.js';

function pickAdapter(cfg: AgentConfigEntry['adapter']): CliAdapter {
  switch (cfg.kind) {
    case 'codex':
      return new CodexAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'claude-code':
      return new ClaudeCodeAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'openclaw':
      return new OpenClawAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    case 'hermes':
      return new HermesAdapter({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        systemPrompt: cfg.systemPrompt,
      });
    default:
      throw new Error(`adapter '${(cfg as any).kind}' not yet implemented`);
  }
}

async function discoverAgents(): Promise<AgentConfigEntry[]> {
  const [_runtimes, agentos, local] = await Promise.all([
    scanRuntimes(),
    scanAgentOSAgents(),
    scanLocalAgents(),
  ]);

  const seen = new Set<string>();
  const results: AgentConfigEntry[] = [];

  for (const s of [...agentos, ...local]) {
    if (seen.has(s.command)) continue;
    seen.add(s.command);

    const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    results.push({
      id,
      name: s.name,
      role: s.category === 'executor-hosted' ? 'executor-agent' : 'gateway-agent',
      category: s.category,
      adapter: {
        kind: s.adapterKind,
        command: s.command,
        args: s.args,
      },
      visibility: 'public',
    });
  }

  logger.info({ discovered: results.map((r) => r.name) }, 'agents discovered via scanning');
  return results;
}

async function startDeviceDaemon(cfg: DeviceConfig) {
  const agents = new Map<string, AgentInstance>();
  for (const entry of cfg.agents) {
    const adapter = pickAdapter(entry.adapter);
    const instance = new AgentInstance(entry, adapter);
    agents.set(entry.id, instance);
    logger.info({ id: entry.id, kind: entry.adapter.kind, visibility: entry.visibility }, 'agent instance created');
  }
  logger.info({ deviceId: cfg.deviceId, agentCount: agents.size }, 'device daemon starting');
  const daemon = createDeviceDaemon(cfg, agents);
  await daemon.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down device daemon');
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function runDeviceMode(cfgPath: string) {
  let cfg: DeviceConfig;
  let scannedEntries: AgentConfigEntry[] | undefined;

  try {
    cfg = loadDeviceConfig(cfgPath);
  } catch (err: any) {
    const shouldScan = err.message?.includes('agents array is required');
    if (!shouldScan) throw err;
    scannedEntries = await discoverAgents();
    if (scannedEntries.length === 0) {
      throw new Error('device config missing and no agents discovered via scanning');
    }
    let fileSettings: Partial<DeviceConfig> = {};
    try {
      const { readFileSync } = await import('node:fs');
      const { load: parseYaml } = await import('js-yaml');
      const raw = parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, any>;
      fileSettings = {
        deviceId: raw.deviceId,
        networkId: raw.networkId,
        server: raw.server,
        heartbeatIntervalMs: raw.heartbeatIntervalMs,
      };
    } catch { /* ignore */ }
    cfg = {
      deviceId: fileSettings.deviceId ?? process.env.DEVICE_ID ?? await getDeviceId(),
      networkId: fileSettings.networkId ?? process.env.NETWORK_ID ?? 'default',
      server: fileSettings.server ?? {
        url: process.env.SERVER_URL ?? 'http://localhost:3000/agent',
        token: process.env.SERVER_TOKEN ?? '',
      },
      heartbeatIntervalMs: fileSettings.heartbeatIntervalMs ?? 10_000,
      agents: scannedEntries,
    };
  }

  if ((cfg as any).scan === true) {
    scannedEntries = await discoverAgents();
    if (scannedEntries.length > 0) {
      cfg = { ...cfg, agents: scannedEntries };
    }
  }

  await startDeviceDaemon(cfg);
}

async function runSingleAgentMode(cfgPath: string) {
  const cfg = loadConfig(cfgPath);
  const adapter = pickAdapter(cfg.adapter);
  logger.info({ id: cfg.id, kind: cfg.adapter.kind }, 'agent daemon starting (single-agent mode)');
  const conn = createConnection(cfg, adapter);
  await conn.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function runCliMode() {
  const { values } = parseArgs({
    options: {
      'server-url': { type: 'string' },
      'token': { type: 'string' },
      'invite': { type: 'string' },
      'device-id': { type: 'string' },
      'network-id': { type: 'string' },
      'help': { type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: agentbean-daemon --server-url <url> --token <token> [--device-id <id>] [--network-id <id>]

Options:
  --server-url   AgentBean Server URL (required)
  --token        Authentication token (required)
  --device-id    Device ID (default: auto-detected from hardware)
  --network-id   Network ID (default: default)
`);
    process.exit(0);
  }

  let serverUrl = values['server-url'] ?? process.env.AGENT_BEAN_SERVER_URL;
  let token = values['token'] ?? process.env.AGENT_BEAN_AGENT_TOKEN;
  let networkId = values['network-id'] ?? 'default';

  if (values.invite) {
    if (!serverUrl) {
      console.error('Error: --server-url is required with --invite.');
      process.exit(1);
    }
    const auth = await runInviteMode(serverUrl, values.invite);
    serverUrl = auth.serverUrl;
    token = auth.token;
    networkId = auth.networkId ?? networkId;
  } else if (!token) {
    const saved = loadAuth();
    if (saved) {
      serverUrl = serverUrl ?? saved.serverUrl;
      token = saved.token;
      networkId = saved.networkId ?? networkId;
    }
  }

  if (!serverUrl || !token) {
    console.error('Error: --server-url and --token are required.');
    console.error('Usage: agentbean-daemon --server-url <url> --token <token>');
    process.exit(1);
  }

  const deviceId = values['device-id'] ?? await getDeviceId();

  logger.info({ serverUrl, deviceId, networkId }, 'CLI mode: auto-discovering agents');
  const agents = await discoverAgents();

  if (agents.length === 0) {
    logger.warn('no agents discovered on this machine. Daemon will start with no agents.');
  }

  const cfg: DeviceConfig = {
    deviceId,
    networkId,
    server: { url: serverUrl, token },
    heartbeatIntervalMs: 10_000,
    agents,
  };

  await startDeviceDaemon(cfg);
}

function normalizeBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/agent\/?$/, '').replace(/\/web\/?$/, '');
}

function normalizeAgentUrl(serverUrl: string): string {
  const base = normalizeBaseUrl(serverUrl);
  return `${base}/agent`;
}

async function runInviteMode(serverUrl: string, inviteCode: string) {
  const { io } = await import('socket.io-client');
  const { execFile } = await import('node:child_process');
  const baseUrl = normalizeBaseUrl(serverUrl);
  const webSocketUrl = `${baseUrl}/web`;

  logger.info({ serverUrl: baseUrl, inviteCode }, 'invite mode: connecting to server');
  const socket = io(webSocketUrl, {
    auth: { invite: true },
    transports: ['websocket'],
    reconnection: false,
  });

  return new Promise<{ token: string; serverUrl: string; userId?: string; networkId?: string }>((resolve, reject) => {
    const fail = (err: Error) => {
      socket.disconnect();
      reject(err);
    };

    socket.on('connect_error', (err) => {
      logger.error({ err: err.message }, 'invite mode: connection failed');
      fail(new Error(`connection failed: ${err.message}`));
    });

    socket.on('connect', () => {
      logger.info('invite mode: connected, validating invite code');
      socket.emit('auth:invite:validate', { code: inviteCode }, (res: any) => {
        if (!res?.ok) {
          fail(new Error(res?.error ?? 'invalid invite code'));
          return;
        }

        const registerUrl = res.registerUrl;
        logger.info({ registerUrl }, 'invite mode: opening browser');
        console.log(`\nOpen this URL to finish joining AgentBean:\n${registerUrl}\n`);
        execFile('open', [registerUrl], (err) => {
          if (err) {
            logger.info({ registerUrl }, 'invite mode: could not open browser automatically');
          }
        });

        console.log('Waiting for registration to complete...');
      });
    });

    socket.on('auth:token:deliver', (payload: any) => {
      if (!payload?.token) return;
      const auth = {
        token: payload.token,
        serverUrl: normalizeAgentUrl(serverUrl),
        userId: payload.userId,
        networkId: payload.networkId,
      };
      saveAuth(auth);
      logger.info({ networkId: auth.networkId }, 'invite mode: token received and saved');
      console.log('Registration complete! Starting daemon...');
      socket.disconnect();
      resolve(auth);
    });
  });
}

export async function main() {
  // Check for CLI flags first (npx mode)
  const hasCliFlags = process.argv.some(
    (a) => a === '--server-url' || a === '--token' || a === '--invite' || a === '--help',
  );

  if (hasCliFlags) {
    await runCliMode();
    return;
  }

  // Fallback: YAML config mode
  const cfgPath = process.env.DEVICE_CONFIG ?? process.env.AGENT_CONFIG ?? './agent.config.yaml';

  try {
    await runDeviceMode(cfgPath);
  } catch (deviceErr: any) {
    if (deviceErr.message?.includes('deviceId') || deviceErr.message?.includes('agents')) {
      logger.info({ reason: deviceErr.message }, 'not a device config, falling back to single-agent mode');
      await runSingleAgentMode(cfgPath);
    } else {
      throw deviceErr;
    }
  }
}
