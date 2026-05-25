import { describe, expect, it } from 'vitest';
import { networkIdFromToken, resolveCliNetworkId } from '../src/index.js';

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
