import { describe, expect, it } from 'vitest';
import { discoveredAgentId, networkIdFromToken, resolveCliNetworkId } from '../src/index.js';

describe('CLI network selection', () => {
  it('extracts the bound team from generated auth tokens', () => {
    expect(networkIdFromToken('user-1:team-1:random')).toBe('team-1');
  });

  it('ignores tokens that do not use the generated auth-token shape', () => {
    expect(networkIdFromToken('opaque-token')).toBeUndefined();
    expect(networkIdFromToken('too:many:parts:here')).toBeUndefined();
  });

  it('uses the token team when --token is provided without --network-id', () => {
    expect(resolveCliNetworkId({
      token: 'user-1:team-from-token:random',
      fallbackNetworkId: 'default',
    })).toBe('team-from-token');
  });

  it('keeps explicit --network-id ahead of token and saved auth defaults', () => {
    expect(resolveCliNetworkId({
      explicitNetworkId: 'explicit-team',
      token: 'user-1:team-from-token:random',
      savedNetworkId: 'saved-team',
      fallbackNetworkId: 'default',
    })).toBe('explicit-team');
  });
});

describe('CLI discovered agent IDs', () => {
  it('scopes discovered agent IDs by device to avoid cross-device kicks', () => {
    expect(discoveredAgentId('Hermes Agent', 'device-1')).toBe('scan-device-1-hermes-agent');
    expect(discoveredAgentId('OpenClaw-Agent', 'device-2')).toBe('scan-device-2-openclaw-agent');
  });

  it('keeps the legacy slug only when no device ID is available', () => {
    expect(discoveredAgentId('Hermes Agent')).toBe('hermes-agent');
  });
});
