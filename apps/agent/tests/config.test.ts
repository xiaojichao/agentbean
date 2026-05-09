import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

let cfgPath: string;
beforeEach(() => { cfgPath = join(tmpdir(), `cfg-${Date.now()}-${Math.random()}.yaml`); });
afterEach(() => { try { unlinkSync(cfgPath); } catch {} });

const baseYaml = `id: a1
name: Shaw-A1
role: social
adapter:
  kind: codex
  command: codex
server:
  url: \${TEST_SERVER_URL}
  token: \${TEST_TOKEN}
`;

describe('loadConfig', () => {
  it('parses YAML and applies env interpolation', () => {
    process.env.TEST_SERVER_URL = 'http://x:4000/agent';
    process.env.TEST_TOKEN = 'tok';
    writeFileSync(cfgPath, baseYaml);
    const cfg = loadConfig(cfgPath);
    expect(cfg.id).toBe('a1');
    expect(cfg.adapter.kind).toBe('codex');
    expect(cfg.server.url).toBe('http://x:4000/agent');
    expect(cfg.server.token).toBe('tok');
    expect(cfg.heartbeatIntervalMs).toBe(10_000);
    expect(cfg.adapter.args).toEqual([]);
  });

  it('rejects unknown adapter.kind', () => {
    writeFileSync(cfgPath, `id: a
name: A
role: r
adapter: { kind: bogus, command: x }
server: { url: u, token: t }
`);
    expect(() => loadConfig(cfgPath)).toThrow(/adapter.kind/);
  });

  it('requires id, name, role', () => {
    writeFileSync(cfgPath, `id: ''
name: ''
role: ''
adapter: { kind: codex, command: x }
server: { url: u, token: t }
`);
    expect(() => loadConfig(cfgPath)).toThrow(/required/);
  });
});
