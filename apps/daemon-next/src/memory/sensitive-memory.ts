const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-_a-z0-9]{12,}\b/i,
  /\bnpm_[a-z0-9]{20,}\b/i,
  /(?:^|[\s/:])_?(?:auth[_-]?token|auth|password|passwd|api[_-]?key|token|client[_-]?secret)\s*(?:=|:|\s)\s*['"]?[^\s,'";]+/i,
  /\b(?:api[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|token|password|passwd|client[_-]?secret|secret|cookie)\s*(?:=|:)\s*[^\s,;]+/i,
  /--(?:api[_-]?key|token|password|passwd|secret|cookie)(?:=|\s+)['"]?[^\s'"]+/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{12,}\b/i,
  /(?:^|\s)[A-Z][A-Z0-9_]{1,63}=\S+/,
  /(?:^|\s)[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|AUTH|ACCESS_KEY)[A-Z0-9_]*\s+['"]?[^\s'"]+/,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\beyJ[a-z0-9_-]{5,}\.eyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{8,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[a-z0-9_-]{35}\b/i,
] as const;

/** Automatic local learning fails closed instead of persisting a guessed redaction. */
export function containsSensitiveMemoryText(value: string | undefined): boolean {
  if (!value) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}

export function containsSensitiveMemoryValue(value: unknown): boolean {
  if (typeof value === 'string') return containsSensitiveMemoryText(value);
  if (Array.isArray(value)) return value.some(containsSensitiveMemoryValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsSensitiveMemoryValue);
}
