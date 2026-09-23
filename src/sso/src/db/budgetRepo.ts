import type { AiCreditsPeriodUsageDto } from '@ghcp/shared';
import { getDb } from './connection.js';

interface AiCreditsUsageRow {
  period_key: string;
  year: number;
  month: number;
  quantity: number;
  unit_type?: string;
  raw_json: string;
  fetched_at: string;
}

export interface AiCreditsUsageCacheRecord extends AiCreditsPeriodUsageDto {
  rawJson: unknown;
}

export function getAiCreditsUsagePeriod(year: number, month: number): AiCreditsUsageCacheRecord | undefined {
  const row = getDb().prepare('SELECT * FROM sso_budget_cache WHERE period_key = ?').get(periodKey(year, month)) as AiCreditsUsageRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function saveAiCreditsUsagePeriod(input: AiCreditsUsageCacheRecord): AiCreditsUsageCacheRecord {
  getDb()
    .prepare(`
      INSERT INTO sso_budget_cache (
        period_key, year, month, quantity, unit_type, raw_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_key) DO UPDATE SET
        year = excluded.year,
        month = excluded.month,
        quantity = excluded.quantity,
        unit_type = excluded.unit_type,
        raw_json = excluded.raw_json,
        fetched_at = excluded.fetched_at
    `)
    .run(
      periodKey(input.year, input.month),
      input.year,
      input.month,
      input.quantity,
      input.unitType,
      JSON.stringify(input.rawJson),
      input.fetchedAt,
    );
  return input;
}

export function countAssignedCopilotSeats(): number {
  return (getDb().prepare("SELECT COUNT(*) AS count FROM sso_users WHERE copilot_seat_status IN ('assigned', 'pending_cancellation')").get() as { count: number }).count;
}

function mapRow(row: AiCreditsUsageRow): AiCreditsUsageCacheRecord {
  return {
    year: row.year,
    month: row.month,
    quantity: row.quantity,
    unitType: row.unit_type,
    rawJson: JSON.parse(row.raw_json) as unknown,
    fetchedAt: row.fetched_at,
  };
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}
