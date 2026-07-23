import type { ImportEmuPlanDto, ImportEmuPlanStatus, ImportEmuPlanSummary, ImportEmuUserRow, ImportEmuUserStatus, PageResponse } from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';

export type EmuImportAction = 'create' | 'update' | 'skip';

export interface EmuImportPlanRowRecord extends ImportEmuUserRow {
  rowIndex: number;
  action?: EmuImportAction;
}

interface PlanRow {
  id: string;
  sso_user?: string;
  status: ImportEmuPlanStatus;
  created_at: string;
  updated_at: string;
  applied_at?: string;
}

interface RowRecord {
  plan_id: string;
  row_index: number;
  sso_user: string;
  email?: string;
  gh_login?: string;
  gh_scim_id?: string;
  emu_status?: ImportEmuUserRow['emuStatus'];
  copilot_seat_status?: ImportEmuUserRow['copilotSeatStatus'];
  status: ImportEmuUserStatus;
  detail: string;
  password_for_login?: string;
  action?: EmuImportAction;
}

export function createEmuImportPlanRecord(input: { id: string; ssoUser?: string; rows: Omit<EmuImportPlanRowRecord, 'rowIndex'>[] }): ImportEmuPlanDto {
  const now = nowIso();
  getDb().transaction(() => {
    getDb()
      .prepare('INSERT INTO sso_emu_import_plans (id, sso_user, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.ssoUser, 'planned', now, now);
    const insertRow = getDb().prepare(`
      INSERT INTO sso_emu_import_plan_rows (
        plan_id, row_index, sso_user, email, gh_login, gh_scim_id, emu_status, copilot_seat_status,
        status, detail, password_for_login, action, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.rows.forEach((row, index) => {
      insertRow.run(
        input.id,
        index + 1,
        row.ssoUser,
        row.email,
        row.ghLogin,
        row.ghScimId,
        row.emuStatus,
        row.copilotSeatStatus,
        row.status,
        row.detail,
        row.passwordForLogin,
        row.action,
        now,
        now,
      );
    });
  })();
  return requireEmuImportPlan(input.id);
}

export function requireEmuImportPlan(planId: string): ImportEmuPlanDto {
  const row = getDb().prepare('SELECT * FROM sso_emu_import_plans WHERE id = ?').get(planId) as PlanRow | undefined;
  if (!row) throw new Error(`EMU import plan "${planId}" was not found.`);
  return toPlanDto(row);
}

export function listEmuImportPlanRows(planId: string, query: { status?: ImportEmuUserStatus; page?: number; pageSize?: number } = {}): PageResponse<ImportEmuUserRow> {
  requireEmuImportPlan(planId);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 100), 500));
  const where = query.status ? 'WHERE plan_id = ? AND status = ?' : 'WHERE plan_id = ?';
  const args = query.status ? [planId, query.status] : [planId];
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM sso_emu_import_plan_rows ${where}`).get(...args) as { count: number }).count;
  const rows = getDb()
    .prepare(`SELECT * FROM sso_emu_import_plan_rows ${where} ORDER BY row_index ASC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as RowRecord[];
  return pageResponse(rows.map(toImportRow), total, page, pageSize);
}

export function listPendingEmuImportPlanRows(planId: string): EmuImportPlanRowRecord[] {
  requireEmuImportPlan(planId);
  const rows = getDb()
    .prepare(`
      SELECT * FROM sso_emu_import_plan_rows
      WHERE plan_id = ? AND status IN ('pending_create', 'pending_update')
      ORDER BY row_index ASC
    `)
    .all(planId) as RowRecord[];
  return rows.map(toPlanRowRecord);
}

export function updateEmuImportPlanRow(planId: string, row: EmuImportPlanRowRecord): void {
  getDb()
    .prepare(`
      UPDATE sso_emu_import_plan_rows
      SET email = ?, gh_login = ?, gh_scim_id = ?, emu_status = ?, copilot_seat_status = ?,
          status = ?, detail = ?, password_for_login = ?, action = ?, updated_at = ?
      WHERE plan_id = ? AND row_index = ?
    `)
    .run(
      row.email,
      row.ghLogin,
      row.ghScimId,
      row.emuStatus,
      row.copilotSeatStatus,
      row.status,
      row.detail,
      row.passwordForLogin,
      row.action,
      nowIso(),
      planId,
      row.rowIndex,
    );
}

export function markEmuImportPlanApplied(planId: string): ImportEmuPlanDto {
  const now = nowIso();
  getDb()
    .prepare("UPDATE sso_emu_import_plans SET status = 'applied', applied_at = COALESCE(applied_at, ?), updated_at = ? WHERE id = ?")
    .run(now, now, planId);
  return requireEmuImportPlan(planId);
}

export function deleteEmuImportPlanRecord(planId: string): boolean {
  requireEmuImportPlan(planId);
  return getDb().transaction(() => {
    getDb().prepare('DELETE FROM sso_emu_import_plan_rows WHERE plan_id = ?').run(planId);
    const result = getDb().prepare('DELETE FROM sso_emu_import_plans WHERE id = ?').run(planId);
    return result.changes > 0;
  })();
}

function toPlanDto(row: PlanRow): ImportEmuPlanDto {
  return {
    planId: row.id,
    ssoUser: row.sso_user,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    summary: summarizeEmuImportPlan(row.id),
  };
}

function summarizeEmuImportPlan(planId: string): ImportEmuPlanSummary {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS count FROM sso_emu_import_plan_rows WHERE plan_id = ? GROUP BY status')
    .all(planId) as { status: ImportEmuUserStatus; count: number }[];
  const counts = new Map(rows.map((row) => [row.status, row.count]));
  const pendingCreate = counts.get('pending_create') ?? 0;
  const pendingUpdate = counts.get('pending_update') ?? 0;
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    pendingCreate,
    pendingUpdate,
    created: counts.get('created') ?? 0,
    updated: counts.get('updated') ?? 0,
    skipped: counts.get('skipped') ?? 0,
    conflict: counts.get('conflict') ?? 0,
    failed: counts.get('failed') ?? 0,
    actionable: pendingCreate + pendingUpdate,
  };
}

function toImportRow(row: RowRecord): ImportEmuUserRow {
  return {
    rowIndex: row.row_index,
    ssoUser: row.sso_user,
    email: row.email,
    ghLogin: row.gh_login,
    ghScimId: row.gh_scim_id,
    emuStatus: row.emu_status,
    copilotSeatStatus: row.copilot_seat_status,
    status: row.status,
    detail: row.detail,
    passwordForLogin: row.password_for_login,
  };
}

function toPlanRowRecord(row: RowRecord): EmuImportPlanRowRecord {
  return {
    ...toImportRow(row),
    rowIndex: row.row_index,
    action: row.action,
  };
}
