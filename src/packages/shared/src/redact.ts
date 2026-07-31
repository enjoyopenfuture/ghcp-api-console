const SECRET_KEY_PARTS = ['password', 'token', 'cookie', 'secret', 'authorization'];

export function maskSecret(value: string, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible * 2) return '<redacted>';
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

export function redactFields<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = shouldRedact(key) ? '<redacted>' : value;
  }
  return redacted;
}

export function shouldRedact(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = shouldRedact(key) ? '<redacted>' : redactSensitiveValue(child);
  }
  return redacted;
}
