import { describe, expect, test } from 'vitest';
import config from '../vitest.config';

describe('web-next Vitest config', () => {
  test('resolves workspace contracts from source in a clean checkout', () => {
    expect(config.resolve?.alias).toMatchObject({
      '@agentbean/contracts': expect.stringMatching(/packages\/contracts\/src\/index\.ts$/),
    });
  });
});
