import { describe, expect, it } from 'vitest';
import { artifactUploadUrl } from '../lib/socket';

describe('artifactUploadUrl', () => {
  it('builds a same-origin authenticated upload URL', () => {
    expect(artifactUploadUrl('team one/x')).toBe('/api/networks/team%20one%2Fx/artifacts/upload?token=');
  });
});
