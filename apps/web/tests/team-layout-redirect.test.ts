import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const teamLayout = readFileSync(new URL('../app/[teamPath]/layout.tsx', import.meta.url), 'utf8');

describe('team layout redirect timing', () => {
  it('does not update the router during render when the team path is unresolved', () => {
    expect(teamLayout).not.toMatch(/if\s*\(\s*teams\.length\s*>\s*0\s*&&\s*!resolved\s*\)\s*{\s*router\.replace\('/s);
  });

  it('redirects unresolved team paths to an available team path instead of hardcoded default', () => {
    expect(teamLayout).toContain("const fallbackTeamPath = teams[0]?.path ?? 'default';");
    expect(teamLayout).toContain("router.replace(`/${fallbackTeamPath}/chat`);");
    expect(teamLayout).not.toContain("router.replace('/default/chat');");
  });
});
