import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProductionTarget } from './check-agentbean-next-production-target.mjs';

const publicDns = async () => [{ address: '104.18.1.1', family: 4 }];

test('accepts only the canonical production origin with public DNS', async () => {
  const result = await checkProductionTarget({
    entryUrl: 'https://api.agentbean.dev',
    resolveHostImpl: publicDns,
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    authority: 'read_only_target_validation',
    origin: 'https://api.agentbean.dev',
    reason: null,
    httpRequestCount: 0,
    mutationCount: 0,
  });
});

test('blocks arbitrary origins before any production request', async () => {
  const result = await checkProductionTarget({
    entryUrl: 'https://example.com',
    resolveHostImpl: async () => { throw new Error('DNS must not run'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target_origin_not_allowed');
  assert.equal(result.httpRequestCount, 0);
});

test('blocks localhost, metadata addresses, URL credentials, and non-http targets', async () => {
  const cases = [
    ['http://localhost:3000', 'target_address_not_public'],
    ['https://api.agentbean.dev', 'target_address_not_public', async () => [{ address: '169.254.169.254', family: 4 }]],
    ['https://user:pass@api.agentbean.dev', 'entry_url_credentials_forbidden'],
    ['file:///tmp/healthz', 'entry_url_protocol_invalid'],
  ];
  for (const [entryUrl, reason, resolver = publicDns] of cases) {
    const result = await checkProductionTarget({ entryUrl, resolveHostImpl: resolver });
    assert.equal(result.ok, false, entryUrl);
    assert.equal(result.reason, reason, entryUrl);
  }
});

test('rejects non-canonical query or fragment without leaking them or DNS errors', async () => {
  const query = await checkProductionTarget({ entryUrl: 'https://api.agentbean.dev/?token=secret#fragment', resolveHostImpl: publicDns });
  const dns = await checkProductionTarget({
    entryUrl: 'https://api.agentbean.dev',
    resolveHostImpl: async () => { throw new Error('resolver secret'); },
  });
  assert.equal(query.ok, false);
  assert.equal(query.reason, 'target_url_not_canonical');
  assert.equal(dns.reason, 'target_resolution_failed');
  assert.doesNotMatch(JSON.stringify([query, dns]), /secret|fragment/);
});
