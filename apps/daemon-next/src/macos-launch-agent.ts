import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deviceServicePaths } from './device-service-paths.js';
import { ensurePrivateDeviceServiceDirectory } from './device-service-filesystem.js';

export const DEVICE_SERVICE_LAUNCH_AGENT_LABEL = 'com.agentbean.device-service';

export interface LaunchctlResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type LaunchctlRunner = (executable: string, argv: readonly string[]) => Promise<LaunchctlResult>;

export interface MacOSLaunchAgentPaths {
  readonly plistFile: string;
  readonly logFile: string;
  readonly errorLogFile: string;
}

export interface PlatformServiceStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly queryFailed: boolean;
}

export interface MacOSLaunchAgentAdapter {
  readonly label: typeof DEVICE_SERVICE_LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly target: string;
  readonly paths: MacOSLaunchAgentPaths;
  bootstrap(): Promise<LaunchctlResult>;
  start(): Promise<LaunchctlResult>;
  kill(): Promise<LaunchctlResult>;
  bootout(): Promise<LaunchctlResult>;
  status(): Promise<PlatformServiceStatus>;
}

export interface CreateMacOSLaunchAgentAdapterInput {
  readonly uid?: number;
  readonly home?: string;
  readonly baseDir?: string;
  readonly run?: LaunchctlRunner;
}

export function macOSLaunchAgentPaths(input: { home?: string; baseDir?: string } = {}): MacOSLaunchAgentPaths {
  const home = input.home ?? homedir();
  const servicePaths = deviceServicePaths(input.baseDir);
  return {
    plistFile: join(home, 'Library', 'LaunchAgents', `${DEVICE_SERVICE_LAUNCH_AGENT_LABEL}.plist`),
    logFile: servicePaths.logFile,
    errorLogFile: join(servicePaths.logDirectory, 'device-service.error.log'),
  };
}

export function createMacOSLaunchAgentAdapter(
  input: CreateMacOSLaunchAgentAdapterInput = {},
): MacOSLaunchAgentAdapter {
  const uid = input.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) throw new Error('SERVICE_PLATFORM_UNSUPPORTED');
  const domain = `gui/${uid}`;
  const target = `${domain}/${DEVICE_SERVICE_LAUNCH_AGENT_LABEL}`;
  const paths = macOSLaunchAgentPaths(input);
  const run = input.run ?? runLaunchctl;
  return {
    label: DEVICE_SERVICE_LAUNCH_AGENT_LABEL,
    domain,
    target,
    paths,
    bootstrap: () => run('/bin/launchctl', ['bootstrap', domain, paths.plistFile]),
    start: () => run('/bin/launchctl', ['kickstart', '-k', target]),
    kill: () => run('/bin/launchctl', ['kill', 'SIGTERM', target]),
    bootout: () => run('/bin/launchctl', ['bootout', domain, paths.plistFile]),
    async status() {
      const installed = await fileExists(paths.plistFile);
      const result = await run('/bin/launchctl', ['print', target]);
      const loaded = result.exitCode === 0;
      return {
        installed,
        loaded,
        running: loaded && launchctlPrintHasLivePid(result.stdout),
        queryFailed: result.exitCode !== 0,
      };
    },
  };
}

export function generateMacOSLaunchAgentPlist(input: {
  readonly executablePath: string;
  readonly home?: string;
  readonly baseDir?: string;
}): string {
  if (!isAbsolute(input.executablePath)) throw new Error('LAUNCH_AGENT_INSTALL_FAILED');
  const executablePath = input.executablePath;
  const paths = macOSLaunchAgentPaths(input);
  const values = {
    label: escapeXml(DEVICE_SERVICE_LAUNCH_AGENT_LABEL),
    executable: escapeXml(executablePath),
    logFile: escapeXml(paths.logFile),
    errorLogFile: escapeXml(paths.errorLogFile),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${values.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.executable}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${values.logFile}</string>
  <key>StandardErrorPath</key>
  <string>${values.errorLogFile}</string>
</dict>
</plist>
`;
}

export async function writeMacOSLaunchAgentPlist(input: {
  readonly executablePath: string;
  readonly home?: string;
  readonly baseDir?: string;
}): Promise<string> {
  const paths = macOSLaunchAgentPaths(input);
  const content = generateMacOSLaunchAgentPlist(input);
  await mkdir(dirname(paths.plistFile), { recursive: true, mode: 0o700 });
  try {
    if (await readFile(paths.plistFile, 'utf8') === content) {
      await chmod(paths.plistFile, 0o600);
      return paths.plistFile;
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const temporaryFile = `${paths.plistFile}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryFile, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryFile, paths.plistFile);
    await chmod(paths.plistFile, 0o600);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
  return paths.plistFile;
}

export async function writeMacOSServicePayload(input: {
  readonly sourceExecutablePath: string;
  readonly nodeExecutablePath: string;
  readonly baseDir?: string;
}): Promise<string> {
  if (!isAbsolute(input.sourceExecutablePath) || !isAbsolute(input.nodeExecutablePath)
    || input.nodeExecutablePath.includes('\n')) throw new Error('LAUNCH_AGENT_INSTALL_FAILED');
  const paths = deviceServicePaths(input.baseDir);
  await ensurePrivateDeviceServiceDirectory(paths.root);
  await ensurePrivateDeviceServiceDirectory(paths.payloadDirectory);
  await ensurePrivateDeviceServiceDirectory(paths.logDirectory);
  const resolvedBaseDir = dirname(paths.root);
  const content = `#!${input.nodeExecutablePath}\nprocess.env.AGENTBEAN_HOME = ${JSON.stringify(resolvedBaseDir)};\nawait import(${JSON.stringify(pathToFileURL(input.sourceExecutablePath).href)});\n`;
  await writeAtomicFile(paths.payloadFile, content, 0o700);
  return paths.payloadFile;
}

export async function removeMacOSLaunchAgentInstallation(input: {
  readonly home?: string;
  readonly baseDir?: string;
} = {}): Promise<void> {
  const launchAgentPaths = macOSLaunchAgentPaths(input);
  const servicePaths = deviceServicePaths(input.baseDir);
  await rm(launchAgentPaths.plistFile, { force: true });
  await rm(servicePaths.payloadDirectory, { recursive: true, force: true });
}

async function writeAtomicFile(path: string, content: string, mode: number): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) {
      await chmod(path, mode);
      return;
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const temporaryFile = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryFile, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryFile, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
}

async function runLaunchctl(executable: string, argv: readonly string[]): Promise<LaunchctlResult> {
  return new Promise((resolveResult) => {
    execFile(executable, [...argv], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function launchctlPrintHasLivePid(stdout: string): boolean {
  const match = stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return Boolean(match?.[1] && Number(match[1]) > 0);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
