import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('device daemon upgrade guidance', () => {
  test('tells users to generate a new connection command when an upgrade is available', () => {
    const source = readFileSync(new URL('../app/[teamPath]/devices/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('{/* CONNECTION */}');
    const end = source.indexOf('{/* AGENT GROUPS */}', start);
    const connectionSection = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(connectionSection).toContain('daemonVersion.updateAvailable &&');
    expect(connectionSection).toContain('旧命令无法升级 Daemon，请生成并运行新的连接命令。');
    expect(connectionSection).toContain('生成新连接命令进行升级');
  });
});
