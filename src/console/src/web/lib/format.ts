import type { CopilotOauthStatus, CopilotSeatStatus, EmuStatus, LoginTaskStatus } from '@ghcp/shared';

export function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatRelativeDate(value?: string): string {
  if (!value) return '-';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const elapsedSeconds = Math.round((Date.now() - timestamp) / 1000);
  const future = elapsedSeconds < 0;
  const elapsed = Math.abs(elapsedSeconds);
  if (elapsed < 60) return future ? 'in a moment' : 'just now';
  const units: Array<[number, string]> = [
    [31_536_000, 'y'],
    [2_592_000, 'mo'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ];
  const [seconds, label] = units.find(([unitSeconds]) => elapsed >= unitSeconds) ?? units[units.length - 1]!;
  const amount = Math.floor(elapsed / seconds);
  return future ? `in ${amount}${label}` : `${amount}${label} ago`;
}

export function formatNumber(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '-';
}

export function tokenTotal(input?: number, output?: number, cache?: number): number | undefined {
  const values = [input, output, cache].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

export function statusTone(status?: CopilotOauthStatus | CopilotSeatStatus | EmuStatus | LoginTaskStatus | string): 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted' {
  switch (status) {
    case 'valid':
    case 'active':
    case 'assigned':
    case 'success':
      return 'success';
    case 'refreshing':
    case 'running':
    case 'pending':
    case 'pending_create':
    case 'pending_update':
      return 'info';
    case 'expired':
    case 'missing':
    case 'not_synced':
    case 'unknown':
      return 'warning';
    case 'failed':
    case 'assign_failed':
    case 'remove_failed':
    case 'conflict':
    case 'deleted':
    case 'cancelled':
      return 'danger';
    case 'suspended':
    case 'unassigned':
    case 'skipped':
      return 'muted';
    case 'created':
    case 'updated':
      return 'success';
    default:
      return 'default';
  }
}

export function summarizeJson(value: unknown): string {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.slice(0, 3).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`).join(', ') || '{}';
  }
  return String(value);
}
