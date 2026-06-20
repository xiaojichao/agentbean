import { existsSync, readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function interpolate(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config references missing env var: ${name}`);
    return v;
  });
}

export function deepInterpolate(node: unknown): unknown {
  if (typeof node === 'string') return interpolate(node);
  if (Array.isArray(node)) return node.map(deepInterpolate);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v);
    return out;
  }
  return node;
}

export function loadYamlConfig(path: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    if (!existsSync(path)) return null;
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return deepInterpolate(raw) as Record<string, unknown>;
}
