import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = resolve(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc');

describe('public declaration boundary', () => {
  it('does not export or reference raw PI SDK types', () => {
    const build = spawnSync(tsc, ['-p', 'tsconfig.json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

    const declarations = [
      'dist/index.d.ts',
      'dist/pi-session-adapter.d.ts',
      'dist/types.d.ts',
    ].map((path) => readFileSync(resolve(packageRoot, path), 'utf8')).join('\n');
    expect(declarations).not.toMatch(/@earendil-works|AgentSession|DefaultResourceLoader|AuthStorage|ModelRegistry|createCodingTools/);

    const negative = spawnSync(tsc, [
      '--noEmit',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--strict',
      '--skipLibCheck',
      'tests/fixtures/raw-pi-import.ts',
    ], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(negative.status).not.toBe(0);
    expect(`${negative.stdout}${negative.stderr}`).toMatch(/has no exported member 'AgentSession'/);
  });
});
