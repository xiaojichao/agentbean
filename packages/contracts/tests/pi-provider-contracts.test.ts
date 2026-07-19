import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import type {
  CreatePiProviderCardInput,
  PiProviderCardDto,
  PiProviderPresetDescriptorDto,
} from '../src/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = resolve(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc');

function compileFixture(path: string) {
  const build = spawnSync(tsc, ['-p', 'tsconfig.json'], { cwd: packageRoot, encoding: 'utf8' });
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
  return spawnSync(tsc, [
    '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', '--strict', '--skipLibCheck', path,
  ], { cwd: packageRoot, encoding: 'utf8' });
}

describe('PI Provider contracts', () => {
  test('freezes admin-facing card DTO without credential secrets', () => {
    const card: PiProviderCardDto = {
      id: 'card-1',
      displayName: 'OpenAI Draft',
      preset: 'openai',
      notes: 'primary',
      consoleUrl: 'https://platform.openai.com',
      credential: {
        credentialRef: 'cred-1',
        configured: true,
        fingerprint: 'abcd1234',
      },
      draftRevision: {
        id: 'rev-1',
        cardId: 'card-1',
        status: 'draft',
        config: {
          protocol: 'openai_chat_completions',
          baseUrl: 'https://api.openai.com/v1',
          endpointMode: 'chat_completions',
          modelId: 'gpt-4.1-mini',
          timeoutMs: 60_000,
          maxOutputTokens: 4096,
          compatibilityParams: {},
        },
        createdBy: 'admin-1',
        createdAt: 1,
      },
      publishedRevision: null,
      createdBy: 'admin-1',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(card.credential.credentialRef).toBe('cred-1');
    expect(JSON.stringify(card)).not.toMatch(/sk-|apiKey|ciphertext|encrypted/i);
  });

  test('create input requires apiKey at the write boundary only', () => {
    const input: CreatePiProviderCardInput = {
      preset: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      endpointMode: 'chat_completions',
      modelId: 'deepseek-chat',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      apiKey: 'sk-test',
    };
    expect(input.apiKey).toBe('sk-test');
  });

  test('exports preset descriptors through public declarations', () => {
    const result = compileFixture('tests/fixtures/pi-provider-contracts-valid.ts');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const declarationFiles = readdirSync(resolve(packageRoot, 'dist'))
      .filter((file) => file.endsWith('.d.ts'));
    expect(declarationFiles.some((file) => file.includes('pi-provider'))).toBe(true);
    for (const file of declarationFiles) {
      const text = readFileSync(resolve(packageRoot, 'dist', file), 'utf8');
      expect(text).not.toMatch(/ciphertext|encryptedSecret|apiKeyCiphertext/i);
    }
  });

  test('rejects team-facing provider supply fields and secret echo types', () => {
    const result = compileFixture('tests/fixtures/pi-provider-contracts-forbidden.ts');
    expect(result.status).not.toBe(0);
    const diagnostics = `${result.stdout}${result.stderr}`;
    for (const forbidden of ['apiKeyCiphertext', 'encryptedApiKey', 'secret', 'teamProviderCard']) {
      expect(diagnostics).toContain(forbidden);
    }
  });

  test('lists four preset descriptors for UI', () => {
    const presets: PiProviderPresetDescriptorDto[] = [
      {
        preset: 'openai',
        displayName: 'OpenAI',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultEndpointMode: 'chat_completions',
        defaultConsoleUrl: 'https://platform.openai.com',
        protocol: 'openai_chat_completions',
      },
    ];
    expect(presets[0]?.preset).toBe('openai');
  });
});
