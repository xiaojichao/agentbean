import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function escapeSchemeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function getWorkspaceDir(agentId: string): string {
  const dir = join(homedir(), '.agentbean', 'workspaces', agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function isSandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    accessSync('/usr/bin/sandbox-exec', constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function generateSandboxProfile(agentId: string, runtimePath: string, writableDirs: string[] = []): string {
  const workspaceDir = getWorkspaceDir(agentId);
  const runtimeDir = runtimePath.includes('/') ? dirname(runtimePath) : '/usr/bin';
  const profilePath = `/tmp/agentbean-sandbox-${agentId}.sb`;
  const extraWritableRules = writableDirs
    .filter(Boolean)
    .map((dir) => `(allow file-read* file-write*
  (subpath "${escapeSchemeString(dir)}"))`)
    .join('\n');
  const profile = `(version 1)
(allow file-read* file-write*
  (subpath "${escapeSchemeString(workspaceDir)}"))
(allow file-read* file-write*
  (subpath "/tmp"))
${extraWritableRules ? `${extraWritableRules}\n` : ''}(allow file-read*
  (subpath "${escapeSchemeString(runtimeDir)}"))
(allow file-read*
  (subpath "/bin")
  (subpath "/usr/bin")
  (subpath "/usr/local/bin")
  (subpath "/opt/homebrew/bin"))
(allow network-outbound
  (remote tcp "api.anthropic.com" 443))
(allow network-outbound
  (remote tcp "api.openai.com" 443))
(deny default)
`;
  writeFileSync(profilePath, profile);
  return profilePath;
}
