const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-_a-z0-9]{12,}\b/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|cookie)\s*(?:=|:)\s*[^\s,;]+/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{12,}\b/i,
  /(?:^|\s)[A-Z][A-Z0-9_]{1,63}=\S+/,
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
