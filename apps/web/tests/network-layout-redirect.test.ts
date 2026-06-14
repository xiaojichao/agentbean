import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const networkLayout = readFileSync(new URL('../app/[networkPath]/layout.tsx', import.meta.url), 'utf8');

describe('network layout redirect timing', () => {
  it('does not update the router during render when the network path is unresolved', () => {
    expect(networkLayout).not.toMatch(/if\s*\(\s*teams\.length\s*>\s*0\s*&&\s*!resolved\s*\)\s*{\s*router\.replace\('/s);
  });

  it('redirects unresolved network paths to an available team path instead of hardcoded default', () => {
    expect(networkLayout).toContain("const fallbackNetworkPath = teams[0]?.path ?? 'default';");
    expect(networkLayout).toContain("router.replace(`/${fallbackNetworkPath}/chat`);");
    expect(networkLayout).not.toContain("router.replace('/default/chat');");
  });
});
