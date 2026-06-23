import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { agentBeanHome, machineIdFile } from './profile-paths.js';

export interface LoadOrCreateMachineIdOptions {
  baseDir?: string;
  generate?: () => string;
}

export function loadOrCreateMachineId(options: LoadOrCreateMachineIdOptions = {}): string {
  const file = machineIdFile(options.baseDir);
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    }
  } catch {
    // Fall through to a generated id; the daemon can still connect.
  }

  const machineId = options.generate?.() ?? randomUUID();
  try {
    mkdirSync(agentBeanHome(options.baseDir), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${machineId}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Persistence is best-effort. Returning the id keeps startup non-blocking.
  }
  return machineId;
}
