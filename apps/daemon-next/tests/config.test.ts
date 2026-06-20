import { writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deepInterpolate, loadYamlConfig } from '../src/config';

describe('deepInterpolate', () => {
  it('substitutes ${VAR} from process.env', () => {
    process.env.MY_VAR = 'hello';
    expect(deepInterpolate('${MY_VAR}')).toBe('hello');
    expect(deepInterpolate({ a: '${MY_VAR}', b: ['${MY_VAR}', 'lit'] })).toEqual({ a: 'hello', b: ['hello', 'lit'] });
    delete process.env.MY_VAR;
  });
  it('throws on missing env var', () => {
    delete process.env.NOPE_X;
    expect(() => deepInterpolate('${NOPE_X}')).toThrow(/missing env var/);
  });
});

describe('loadYamlConfig', () => {
  it('loads + interpolates a yaml file', () => {
    process.env.SRV = 'http://x';
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(dir, 'c.yaml'), 'serverUrl: ${SRV}\nteamId: t1\n');
    const cfg = loadYamlConfig(join(dir, 'c.yaml'));
    expect(cfg).toEqual({ serverUrl: 'http://x', teamId: 't1' });
    delete process.env.SRV;
  });
  it('returns null when file missing', () => {
    expect(loadYamlConfig(join(tmpdir(), 'nope.yaml'))).toBeNull();
  });
  it('returns null on corrupt YAML', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(dir, 'c.yaml'), 'serverUrl: ${SRV}\n  bad-indent: oops\n- [unclosed\n');
    expect(loadYamlConfig(join(dir, 'c.yaml'))).toBeNull();
  });
  it('returns null when YAML parses to a scalar', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(dir, 'c.yaml'), 'just-a-string\n');
    expect(loadYamlConfig(join(dir, 'c.yaml'))).toBeNull();
  });
  it('returns null when YAML parses to a top-level array', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(dir, 'c.yaml'), '- foo\n- bar\n');
    expect(loadYamlConfig(join(dir, 'c.yaml'))).toBeNull();
  });
});
