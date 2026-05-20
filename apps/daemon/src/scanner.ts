import { execFile } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as os from "node:os";
import type { AgentCategory, AdapterKind } from "./config.js";
import { logger } from "./log.js";

function readDaemonVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

const DAEMON_VERSION = readDaemonVersion();

// --- Runtime (not an Agent, just an installed CLI tool) ---

export interface RuntimeInfo {
  name: string;
  adapterKind: AdapterKind;
  command: string;
  installed: boolean;
}

// --- Discovered Agent (is an Agent, can be auto-added) ---

export interface ScannedAgent {
  category: AgentCategory;
  name: string;
  adapterKind: AdapterKind;
  command: string;
  args: string[];
  cwd?: string;
  source: "gateway" | "filesystem";
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function getExtraPathEntries(): string[] {
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(os.homedir(), '.local/bin'),
    join(os.homedir(), '.bun/bin'),
    join(os.homedir(), '.npm-global/bin'),
    join(os.homedir(), '.asdf/shims'),
    join(os.homedir(), '.local/share/mise/shims'),
    ...getAllNodeVersions().map((version) => join(os.homedir(), '.nvm/versions/node', version, 'bin')),
  ];
}

function which(bin: string, candidatePaths: string[] = []): Promise<string | null> {
  return new Promise((resolve) => {
    for (const candidate of candidatePaths) {
      if (isExecutableFile(candidate)) {
        resolve(candidate);
        return;
      }
    }
    const child = execFile(
      'which',
      [bin],
      { timeout: 5_000, env: { ...process.env, PATH: [process.env.PATH, ...getExtraPathEntries()].filter(Boolean).join(':') } },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const path = stdout.trim();
        resolve(path.length > 0 ? path : null);
      },
    );
    child.on('error', () => resolve(null));
  });
}

function getAllNodeVersions(): string[] {
  try {
    const nvmDir = join(os.homedir(), '.nvm/versions/node');
    if (!existsSync(nvmDir)) return [];
    return readdirSync(nvmDir);
  } catch { return []; }
}

function getClaudeCodeCandidates(): string[] {
  const latestDir = join(os.homedir(), '.local/share/claude-latest');
  const legacyDir = join(os.homedir(), '.local/share/claude');
  const candidates = [
    join(latestDir, 'current/claude'),
    join(legacyDir, 'current/claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];

  for (const base of [latestDir, legacyDir]) {
    const versionsDir = join(base, 'versions');
    try {
      if (!existsSync(versionsDir)) continue;
      const versions = readdirSync(versionsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) candidates.push(join(versionsDir, version, 'claude'));
    } catch {
      // Ignore unreadable version directories and continue with other candidates.
    }
  }
  return candidates;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 10_000 }, (err, stdout) => {
      resolve(stdout?.trim() ?? "");
    });
    child.on("error", () => resolve(""));
  });
}

// --- Machine ID (stable per-device identifier) ---

const MACHINE_ID_FILE = join(os.homedir(), ".agentbean", "device-id");

function getFirstMacAddress(): string | null {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // Skip internal (loopback) and zero MAC
      if (addr.internal) continue;
      if (addr.mac === "00:00:00:00:00:00") continue;
      return addr.mac;
    }
  }
  return null;
}

async function readPlatformMachineId(): Promise<string | null> {
  const platform = os.platform();
  try {
    if (platform === "linux") {
      if (existsSync("/etc/machine-id")) {
        return readFileSync("/etc/machine-id", "utf-8").trim() || null;
      }
    } else if (platform === "darwin") {
      const output = await run("ioreg", [
        "-rd1",
        "-c",
        "IOPlatformExpertDevice",
      ]);
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) return match[1] ?? null;
    } else if (platform === "win32") {
      const output = await run("reg", [
        "query",
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match) return match[1] ?? null;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Get a stable device ID unique to this machine.
 * Priority: cached file > platform machine-id > MAC address > random UUID
 * Result is cached to ~/.agentbean/device-id
 */
export async function getDeviceId(): Promise<string> {
  // 1. Read cached ID
  if (existsSync(MACHINE_ID_FILE)) {
    const cached = readFileSync(MACHINE_ID_FILE, "utf-8").trim();
    if (cached) return cached;
  }

  // 2. Collect hardware fingerprint
  const parts: string[] = [];

  const platformId = await readPlatformMachineId();
  if (platformId) parts.push(`platform:${platformId}`);

  const mac = getFirstMacAddress();
  if (mac) parts.push(`mac:${mac}`);

  parts.push(`hostname:${os.hostname()}`);
  parts.push(`arch:${os.arch()}`);
  parts.push(`platform:${os.platform()}`);

  let deviceId: string;

  if (parts.length > 2) {
    // We have enough hardware info — generate deterministic ID
    const hash = createHash("sha256").update(parts.join("|")).digest("hex");
    // Format as UUID: 8-4-4-4-12
    deviceId = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  } else {
    // Fallback: random UUID
    const { randomUUID } = await import("node:crypto");
    deviceId = randomUUID();
  }

  // 3. Cache to file
  try {
    const dir = join(os.homedir(), ".agentbean");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(MACHINE_ID_FILE, deviceId);
  } catch {
    // non-fatal
  }

  return deviceId;
}

// --- Scan Coding Agent Runtimes (Claude Code, Codex, Kimi) ---

export async function scanRuntimes(): Promise<RuntimeInfo[]> {
  const checks = [
    {
      bin: "claude",
      name: "Claude Code",
      adapterKind: "claude-code" as AdapterKind,
      candidates: getClaudeCodeCandidates(),
    },
    { bin: "codex", name: "Codex CLI", adapterKind: "codex" as AdapterKind, candidates: [] },
    {
      bin: "kimi-cli",
      name: "Kimi CLI",
      adapterKind: "Kimi-cli" as AdapterKind,
      candidates: [],
    },
  ];

  const results: RuntimeInfo[] = [];
  for (const s of checks) {
    const path = await which(s.bin, s.candidates);
    results.push({
      name: s.name,
      adapterKind: s.adapterKind,
      command: path ?? "",
      installed: path !== null,
    });
  }
  return results;
}

// --- Scan AgentOS Gateways (Hermes, OpenClaw) ---

async function checkHermesGateway(): Promise<ScannedAgent | null> {
  const path = await which("hermes");
  if (!path) return null;

  const status = await run("hermes", ["gateway", "status"]);
  const running = status.includes("running") || status.includes("✓");

  if (running) {
    return {
      category: "agentos-hosted",
      name: "Hermes-Agent",
      adapterKind: "hermes",
      command: path,
      args: [],
      source: "gateway",
    };
  }
  return null;
}

async function checkOpenClawGateway(): Promise<ScannedAgent | null> {
  const path = await which("openclaw");
  if (!path) return null;

  const status = await run("openclaw", ["gateway", "status"]);
  const running = status.includes("running") || status.includes("✓");

  if (running) {
    return {
      category: "agentos-hosted",
      name: "OpenClaw-Agent",
      adapterKind: "openclaw",
      command: path,
      args: ["gateway", "run"],
      source: "gateway",
    };
  }
  return null;
}

export async function scanAgentOSAgents(): Promise<ScannedAgent[]> {
  const [hermes, openclaw] = await Promise.all([
    checkHermesGateway(),
    checkOpenClawGateway(),
  ]);
  return [hermes, openclaw].filter((a): a is ScannedAgent => a !== null);
}

// --- Scan local agent definitions from filesystem ---

export async function scanLocalAgents(
  scanDir = join(os.homedir(), ".agentbean", "agents"),
): Promise<ScannedAgent[]> {
  if (!existsSync(scanDir)) {
    return [];
  }

  const results: ScannedAgent[] = [];
  let entries: string[];
  try {
    entries = readdirSync(scanDir);
  } catch (err: any) {
    logger?.warn?.({ err: err?.message }, "scan failed");
    return [];
  }

  for (const entry of entries) {
    const subdir = join(scanDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(subdir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const jsonPath = join(subdir, "agent.json");
    const yamlPath = join(subdir, "agent.yaml");
    const ymlPath = join(subdir, "agent.yml");

    let raw: string | null = null;
    let ext: "json" | "yaml" | null = null;
    if (existsSync(jsonPath)) {
      raw = readFileSync(jsonPath, "utf8");
      ext = "json";
    } else if (existsSync(yamlPath)) {
      raw = readFileSync(yamlPath, "utf8");
      ext = "yaml";
    } else if (existsSync(ymlPath)) {
      raw = readFileSync(ymlPath, "utf8");
      ext = "yaml";
    }

    if (raw === null || ext === null) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      if (ext === "json") {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } else {
        const { load: parseYaml } = await import("js-yaml");
        parsed = parseYaml(raw) as Record<string, unknown> | null;
      }
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;

    const name = (
      typeof parsed.name === "string" ? parsed.name : entry
    ).replace(/\s+/g, "-");
    const command = typeof parsed.command === "string" ? parsed.command : "";
    const args = Array.isArray(parsed.args)
      ? (parsed.args as unknown[]).map(String)
      : [];

    let category: AgentCategory;
    if (
      typeof parsed.category === "string" &&
      ["executor-hosted", "agentos-hosted"].includes(parsed.category)
    ) {
      category = parsed.category as AgentCategory;
    } else if ("executor" in parsed) {
      category = "executor-hosted";
    } else {
      category = "executor-hosted";
    }

    const adapterKind =
      typeof parsed.adapterKind === "string" &&
      ["codex", "claude-code", "openclaw", "hermes"].includes(
        parsed.adapterKind,
      )
        ? (parsed.adapterKind as AdapterKind)
        : "codex";

    results.push({
      category,
      name,
      adapterKind,
      command,
      args,
      source: "filesystem",
    });
  }

  return results;
}

// --- System Info ---

export interface SystemInfo {
  platform: string; // darwin, linux, win32
  arch: string; // arm64, x64
  osVersion: string; // e.g. "macOS 24.4.0" or "Linux 6.1.0"
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: number;
  freeMemoryGB: number;
  nodeVersion: string;
  daemonVersion: string;
}

export function collectSystemInfo(): SystemInfo {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const platform = os.platform();

  let osVersion = `${os.type()} ${os.release()}`;
  if (platform === "darwin") {
    osVersion = `macOS ${os.release()}`;
  }

  return {
    platform,
    arch: os.arch(),
    osVersion,
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemoryGB: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
    freeMemoryGB: Math.round((freeMem / 1024 / 1024 / 1024) * 10) / 10,
    nodeVersion: process.version,
    daemonVersion: DAEMON_VERSION,
  };
}
