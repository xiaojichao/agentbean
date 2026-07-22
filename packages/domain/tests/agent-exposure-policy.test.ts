import { describe, expect, test } from 'vitest';

import {
  AGENT_EXPOSURE_ERROR,
  evaluatePublishWindow,
  evaluateRestriction,
  parseAgentExposureContent,
} from '../src/agent-exposure-policy.js';

const cap = (name: string, description = 'd') => ({ name, description });
const skill = (name: string, description = 's') => ({ name, description });

describe('parseAgentExposureContent', () => {
  test('accepts minimal valid content (one capability, no skills)', () => {
    const result = parseAgentExposureContent({ capabilities: [cap('code-review')], skills: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.capabilities).toEqual([cap('code-review', 'd')]);
      expect(result.content.skills).toEqual([]);
      expect(result.content.constraints).toEqual([]);
      expect(result.content.availability).toEqual({ status: 'available' });
    }
  });

  test('requires at least one capability', () => {
    const result = parseAgentExposureContent({ capabilities: [], skills: [] });
    expect(result).toEqual({ ok: false, code: AGENT_EXPOSURE_ERROR.EMPTY_CAPABILITIES, message: expect.any(String) });
  });

  test('rejects duplicate capability names (case-insensitive)', () => {
    const result = parseAgentExposureContent({ capabilities: [cap('code-review'), cap('Code-Review')], skills: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.DUPLICATE_CAPABILITY);
  });

  test('rejects empty / over-long capability name', () => {
    const emptyName = parseAgentExposureContent({ capabilities: [{ name: ' ', description: 'd' }], skills: [] });
    expect(emptyName.ok).toBe(false);
    const longName = parseAgentExposureContent({
      capabilities: [{ name: 'x'.repeat(200), description: 'd' }], skills: [],
    });
    expect(longName.ok).toBe(false);
  });

  test('rejects duplicate skill names', () => {
    const result = parseAgentExposureContent({
      capabilities: [cap('code-review')], skills: [skill('lint'), skill('lint')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.DUPLICATE_SKILL);
  });

  test('rejects invalid availability status', () => {
    const result = parseAgentExposureContent({
      capabilities: [cap('code-review')], skills: [], availability: { status: 'maybe' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.INVALID_AVAILABILITY);
  });

  test('rejects validUntil earlier than validFrom', () => {
    const result = parseAgentExposureContent({
      capabilities: [cap('code-review')], skills: [], validFrom: 1000, validUntil: 500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.INVALID_VALIDITY);
  });

  test('accepts null validUntil (long-term)', () => {
    const result = parseAgentExposureContent({
      capabilities: [cap('code-review')], skills: [], validFrom: 1000, validUntil: null,
    });
    expect(result.ok).toBe(true);
  });

  test('fail-closes on wrong-typed payload', () => {
    expect(parseAgentExposureContent(null).ok).toBe(false);
    expect(parseAgentExposureContent({ capabilities: 'nope' }).ok).toBe(false);
    expect(parseAgentExposureContent({ capabilities: [{ name: 1 }] }).ok).toBe(false);
  });
});

describe('evaluateRestriction (AC#4: 只能收紧已公开 operation)', () => {
  const activeCapabilities = ['code-review', 'lint'];
  const activeSkills = ['typescript', 'python'];

  test('accepts disabling a subset of published capabilities/skills', () => {
    const result = evaluateRestriction({
      activeCapabilities, activeSkills,
      disabledCapabilities: ['lint'], disabledSkills: ['python'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.disabledCapabilities).toEqual(['lint']);
      expect(result.disabledSkills).toEqual(['python']);
    }
  });

  test('fail-closed when disabling a capability NOT in active manifest (禁止新增/越权)', () => {
    const result = evaluateRestriction({
      activeCapabilities, activeSkills,
      disabledCapabilities: ['deploy-prod'], disabledSkills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.RESTRICTION_REFERENCES_UNKNOWN_CAPABILITY);
  });

  test('fail-closed when disabling a skill NOT in active manifest', () => {
    const result = evaluateRestriction({
      activeCapabilities, activeSkills,
      disabledCapabilities: [], disabledSkills: ['rust'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.RESTRICTION_REFERENCES_UNKNOWN_SKILL);
  });

  test('deduplicates disabled entries', () => {
    const result = evaluateRestriction({
      activeCapabilities, activeSkills,
      disabledCapabilities: ['lint', 'lint'], disabledSkills: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.disabledCapabilities).toEqual(['lint']);
  });
});

describe('evaluatePublishWindow', () => {
  test('ok when validUntil is null', () => {
    expect(evaluatePublishWindow({ validFrom: 1000, validUntil: null, now: 2000 }).ok).toBe(true);
  });

  test('ok when validUntil is in the future', () => {
    expect(evaluatePublishWindow({ validFrom: 1000, validUntil: 3000, now: 2000 }).ok).toBe(true);
  });

  test('fail when manifest already expired at publish time', () => {
    const result = evaluatePublishWindow({ validFrom: 1000, validUntil: 1500, now: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(AGENT_EXPOSURE_ERROR.INVALID_VALIDITY);
  });
});
