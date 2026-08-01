import type { BatchResult, CreateImportEmuPlanRequest, EnsureSsoUserResponse, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUsersRequest, ImportEmuUserStatus, PageResponse, SsoUserBatchRequest, SsoUserBatchRow, SsoUserCapacityDto, SsoUserDto } from '@ghcp/shared';
import { errorFields, loggerFor } from '@ghcp/shared';
import { newBatchId, nowIso } from '@ghcp/shared';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { assignCopilotSeat, CopilotSeatNotAssignedError, listCopilotSeatAssignments, removeCopilotSeat } from '../copilot/seats.js';
import { getDb } from '../db/connection.js';
import {
  createEmuImportPlanRecord,
  deleteEmuImportPlanRecord,
  listEmuImportPlanRows as listStoredEmuImportPlanRows,
  listPendingEmuImportPlanRows,
  markEmuImportPlanApplied,
  requireEmuImportPlan,
  updateEmuImportPlanRow,
  type EmuImportPlanRowRecord,
} from '../db/emuImportPlansRepo.js';
import { appendUserEvent } from '../db/eventLog.js';
import { deleteProxyAccountsBySsoUser } from '../clients/proxyClient.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import {
  createUser,
  countUsers,
  deleteUser,
  getUser,
  getUserByGhLogin,
  listAllUsers,
  toDto,
  updateEmu,
  updateCopilotSeat,
  updateCopilotSeatFromGitHub,
  updateUser,
  SsoUserLimitReachedError,
  type SsoUserRecord,
} from '../db/usersRepo.js';
import { deleteProvisionedUser, findScimUserByUsername, listScimUsers, suspendUser, syncUser, type ScimEnterpriseRole, type ScimUserResource } from '../scim/scimClient.js';
import { normalizeHandle } from '../scim/handle.js';
import { parseBulkImportText } from './bulkImport.js';
import { knownDefaultPasswordForUser, resolveInitialPassword } from './passwordPolicy.js';

const logger = loggerFor('sso', 'users');

type PlannedEmuAction = 'create' | 'update' | 'skip';

interface PlannedEmuImportRow extends ImportEmuUserRow {
  action?: PlannedEmuAction;
  scimUser?: ScimUserResource;
}

interface SsoUserOperationOutcome {
  user?: SsoUserDto;
  warning?: string;
}

interface CopilotSeatRemovalOutcome {
  user: SsoUserRecord;
  warning?: string;
}

export function ensureUser(identity: string, preferredSsoUser?: string): EnsureSsoUserResponse {
  const candidates = ensureSsoUserCandidates(identity, preferredSsoUser);
  const baseSsoUser = candidates[0] ?? ssoUserFromEnsureInput(identity);
  const existing = findExistingEnsureUser(identity, preferredSsoUser, candidates);
  if (existing) {
    logger.info('ensure-user', 'SSO user already exists', { identity, ssoUser: existing.ssoUser });
    const passwordForLogin = knownDefaultPasswordForUser(existing);
    return { user: toDto(existing), passwordForLogin, created: false };
  }
  const settings = getSsoRuntimeSettings();
  const ssoUser = nextAvailableSsoUser(baseSsoUser || identity, settings.userPrefix);
  const password = resolveInitialPassword(ssoUser);
  const { passwordHash, salt } = hashPassword(password);
  const user = createUser({
    ssoUser,
    passwordHash,
    salt,
    email: `${ssoUser}@${settings.emailDomain}`,
    role: 'user',
  });
  appendUserEvent('create', user);
  logger.info('ensure-user-created', 'Created SSO user for identity', { identity, ssoUser: user.ssoUser });
  return { user: toDto(user), passwordForLogin: password, created: true };
}

export function getSsoUserCapacity(): SsoUserCapacityDto {
  const current = countUsers();
  const limit = getSsoRuntimeSettings().maxSsoUsers;
  return {
    current,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - current),
    reached: limit !== null && current >= limit,
  };
}

export function createSsoUser(input: { ssoUser: string; password?: string; email?: string; role?: 'user' | 'admin' }): SsoUserDto {
  const ssoUser = sanitizeSsoUser(input.ssoUser);
  if (!ssoUser) throw new Error('ssoUser is required');
  if (getUser(ssoUser)) throw new Error(`SSO user "${ssoUser}" already exists.`);
  const password = resolveInitialPassword(ssoUser, input.password);
  const settings = getSsoRuntimeSettings();
  const { passwordHash, salt } = hashPassword(password);
  const user = createUser({
    ssoUser,
    passwordHash,
    salt,
    email: input.email || `${ssoUser}@${settings.emailDomain}`,
    role: input.role ?? 'user',
  });
  appendUserEvent('create', user);
  logger.info('create-user', 'Created SSO user', { ssoUser: user.ssoUser, email: user.email, role: user.role });
  return toDto(user);
}

export function patchSsoUser(ssoUser: string, input: { password?: string; email?: string; role?: 'user' | 'admin' }): SsoUserDto | undefined {
  const patch: Parameters<typeof updateUser>[1] = {};
  if (input.email !== undefined) patch.email = input.email;
  if (input.role !== undefined) patch.role = input.role;
  if (input.password) {
    const hashed = hashPassword(input.password);
    patch.passwordHash = hashed.passwordHash;
    patch.salt = hashed.salt;
  }
  const user = updateUser(ssoUser, patch);
  if (user) logger.info('patch-user', 'Updated SSO user', { ssoUser: user.ssoUser, changedPassword: Boolean(input.password), emailChanged: input.email !== undefined, roleChanged: input.role !== undefined });
  return user ? toDto(user) : undefined;
}

export async function deleteSsoUser(ssoUser: string): Promise<{ deleted: boolean; warning?: string }> {
  const user = getUser(ssoUser);
  if (!user) return { deleted: false };
  logger.info('delete-user-start', 'Deleting SSO user', { ssoUser });
  const seatRemoval = await removeCopilotSeatForUser(user);
  await deleteProvisionedUser(user);
  const proxyDelete = await deleteProxyAccountsBySsoUser(user.ssoUser);
  logger.info('delete-user-proxy-cleaned', 'Deleted proxy data for SSO user', { ...proxyDelete });
  const deleted = deleteUser(ssoUser);
  if (deleted) appendUserEvent('delete', user);
  logger.info('delete-user-done', 'Deleted SSO user', { ssoUser, deleted });
  return { deleted, warning: seatRemoval.warning };
}

export async function syncSsoUser(ssoUser: string, enterpriseRole?: ScimEnterpriseRole): Promise<SsoUserDto> {
  const user = requireUser(ssoUser);
  const resolvedEnterpriseRole = enterpriseRole ?? enterpriseRoleForSsoUser(user);
  logger.info('sync-emu-start', 'Syncing SSO user to GH login', { ssoUser, enterpriseRole: resolvedEnterpriseRole });
  const provisioned = await syncUser(user, resolvedEnterpriseRole);
  const updated = updateEmu(ssoUser, {
    ghLogin: provisioned.ghLogin,
    ghScimId: provisioned.scimId,
    emuStatus: 'active',
  });
  const withSeat = await assignCopilotSeatForUser(updated, provisioned.ghLogin);
  logger.info('sync-emu-done', 'Synced SSO user to GH login and assigned Copilot seat', { ssoUser, ghLogin: withSeat.ghLogin, ghScimId: withSeat.ghScimId });
  return toDto(withSeat);
}

export async function suspendSsoUser(ssoUser: string): Promise<SsoUserDto> {
  const user = requireUser(ssoUser);
  if (!user.ghScimId) throw new Error(`SSO user "${ssoUser}" is not synced to a GH login.`);
  logger.info('suspend-emu-start', 'Suspending GH login', { ssoUser, ghScimId: user.ghScimId });
  await suspendUser(user.ghScimId);
  const updated = updateEmu(ssoUser, { ghLogin: user.ghLogin, ghScimId: user.ghScimId, emuStatus: 'suspended' });
  logger.info('suspend-emu-done', 'Suspended GH login', { ssoUser, ghScimId: user.ghScimId });
  return toDto(updated);
}

export async function deleteEmuUser(ssoUser: string): Promise<SsoUserOperationOutcome> {
  const user = requireUser(ssoUser);
  logger.info('delete-emu-start', 'Deleting provisioned GH login', { ssoUser, ghScimId: user.ghScimId });
  const seatRemoval = await removeCopilotSeatForUser(user);
  await deleteProvisionedUser(user);
  const updated = updateEmu(ssoUser, { emuStatus: 'not_synced' });
  logger.info('delete-emu-done', 'Deleted provisioned GH login', { ssoUser });
  return { user: toDto(updated), warning: seatRemoval.warning };
}

export async function assignCopilotSeatForSsoUser(ssoUser: string): Promise<SsoUserDto> {
  const user = requireUser(ssoUser);
  const updated = await assignCopilotSeatForUser(user);
  logger.info('assign-copilot-seat', 'Assigned GitHub Copilot seat', { ssoUser, ghLogin: updated.ghLogin });
  return toDto(updated);
}

export async function removeCopilotSeatForSsoUser(ssoUser: string): Promise<SsoUserOperationOutcome> {
  const user = requireUser(ssoUser);
  const result = await removeCopilotSeatForUser(user);
  if (!result.warning) {
    logger.info('remove-copilot-seat', 'Removed GitHub Copilot seat', { ssoUser, ghLogin: result.user.ghLogin });
  }
  return { user: toDto(result.user), warning: result.warning };
}

export async function runSsoUserBatch(input: SsoUserBatchRequest): Promise<BatchResult<SsoUserBatchRow>> {
  const startedAt = nowIso();
  const ssoUsers = uniqueSsoUsers(input.ssoUsers);
  let rows: SsoUserBatchRow[];
  logger.info('batch-start', 'Starting SSO user batch operation', { operation: input.operation, total: ssoUsers.length, enterpriseRole: input.enterpriseRole });
  if (input.operation === 'sync_emu') {
    rows = await mapWithConcurrency(ssoUsers, getSsoRuntimeSettings().bulkSyncConcurrency, (ssoUser) => runBatchResultRow(ssoUser, input));
  } else {
    rows = [];
    for (const ssoUser of ssoUsers) {
      rows.push(await runBatchResultRow(ssoUser, input));
    }
  }
  const failed = rows.filter((row) => row.status === 'failed').length;
  const warnings = rows.filter((row) => row.warning).length;
  logger.info('batch-done', 'Finished SSO user batch operation', { operation: input.operation, total: rows.length, success: rows.length - failed, warnings, failed });
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, warnings, failed },
    rows,
  };
}

export async function importEmuUsers(input: ImportEmuUsersRequest = {}): Promise<BatchResult<ImportEmuUserRow>> {
  const startedAt = nowIso();
  const plan = await createEmuImportPlan({ ssoUser: input.ssoUser });
  const appliedPlan = input.dryRun ? plan : applyEmuImportPlan(plan.planId);
  const rows = listAllStoredEmuImportPlanRows(appliedPlan.planId);
  return batchResult(startedAt, rows);
}

export async function createEmuImportPlan(input: CreateImportEmuPlanRequest = {}): Promise<ImportEmuPlanDto> {
  const targetSsoUser = input.ssoUser?.trim();
  const scimUsers = await loadScimUsersForImport(targetSsoUser);
  const assignedCopilotGhLogins = scimUsers.length > 0 ? await listCopilotSeatAssignments() : new Set<string>();
  const settings = getSsoRuntimeSettings();
  const plannedRows = scimUsers.length > 0
    ? buildEmuImportPlan(scimUsers, assignedCopilotGhLogins, settings.emailDomain)
    : [{ ssoUser: targetSsoUser ?? '', status: 'failed', detail: 'GH SCIM user was not found.' } satisfies PlannedEmuImportRow];
  const plan = createEmuImportPlanRecord({
    id: newBatchId(),
    ssoUser: targetSsoUser || undefined,
    rows: plannedRows.map(withoutScimUser),
  });
  logger.info('create-emu-import-plan', 'Created GH login import alignment plan', { planId: plan.planId, ssoUser: targetSsoUser, ...plan.summary });
  return plan;
}

export function getEmuImportPlan(planId: string): ImportEmuPlanDto {
  return requireEmuImportPlan(planId);
}

export function listEmuImportPlanRows(planId: string, query: { status?: ImportEmuUserStatus; page?: number; pageSize?: number } = {}): PageResponse<ImportEmuUserRow> {
  return listStoredEmuImportPlanRows(planId, query);
}

export function applyEmuImportPlan(planId: string): ImportEmuPlanDto {
  requireEmuImportPlan(planId);
  const pendingRows = listPendingEmuImportPlanRows(planId);
  getDb().transaction(() => {
    const localUsers = listAllUsers();
    const localBySsoUser = new Map(localUsers.map((user) => [user.ssoUser.toLowerCase(), user]));
    const localByScimId = new Map(localUsers.filter((user) => user.ghScimId).map((user) => [user.ghScimId!, user]));
    for (const row of pendingRows) {
      let applied: EmuImportPlanRowRecord;
      try {
        applied = applyStoredEmuImportRow(row, localBySsoUser, localByScimId);
      } catch (err) {
        if (!(err instanceof SsoUserLimitReachedError)) throw err;
        applied = { ...row, action: undefined, status: 'failed', detail: err.message };
      }
      updateEmuImportPlanRow(planId, applied);
    }
    markEmuImportPlanApplied(planId);
  })();
  const plan = requireEmuImportPlan(planId);
  logger.info('apply-emu-import-plan', 'Applied EMU import alignment plan', { planId, ...plan.summary });
  return plan;
}

export function deleteEmuImportPlan(planId: string): boolean {
  const deleted = deleteEmuImportPlanRecord(planId);
  logger.info('delete-emu-import-plan', 'Deleted EMU import alignment plan data', { planId, deleted });
  return deleted;
}

export function importUsers(csvText: string): BatchResult<{ line: number; ssoUser: string; status: string; detail: string }> {
  const startedAt = nowIso();
  const parsed = parseBulkImportText(csvText);
  const rows: { line: number; ssoUser: string; status: string; detail: string }[] = [];
  for (const row of parsed.rows) {
    try {
      const existing = getUser(row.ssoUser);
      if (existing && row.password !== undefined) {
        const hashed = hashPassword(row.password);
        updateUser(row.ssoUser, { passwordHash: hashed.passwordHash, salt: hashed.salt });
        rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'updated', detail: 'Updated password' });
      } else if (existing) {
        rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'unchanged', detail: 'Existing SSO user password was left unchanged' });
      } else {
        createSsoUser({ ssoUser: row.ssoUser, password: row.password });
        rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'created', detail: 'Created SSO user' });
      }
    } catch (err) {
      rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'failed', detail: (err as Error).message });
    }
  }
  for (const error of parsed.errors) {
    rows.push({ line: error.line, ssoUser: error.ssoUser ?? '', status: 'failed', detail: error.error });
  }
  const failed = rows.filter((r) => r.status === 'failed').length;
  logger.info('import-users', 'Imported SSO users', { total: rows.length, success: rows.length - failed, failed });
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, failed },
    rows: rows.sort((a, b) => a.line - b.line),
  };
}

function requireUser(ssoUser: string): SsoUserRecord {
  const user = getUser(ssoUser);
  if (!user) throw new Error(`SSO user "${ssoUser}" was not found.`);
  return user;
}

async function runSsoUserBatchRow(ssoUser: string, input: SsoUserBatchRequest): Promise<SsoUserOperationOutcome> {
  switch (input.operation) {
    case 'sync_emu':
      return { user: await syncSsoUser(ssoUser, input.enterpriseRole) };
    case 'assign_copilot':
      return { user: await assignCopilotSeatForSsoUser(ssoUser) };
    case 'remove_copilot':
      return removeCopilotSeatForSsoUser(ssoUser);
    case 'suspend_emu':
      return { user: await suspendSsoUser(ssoUser) };
    case 'delete_emu':
      return deleteEmuUser(ssoUser);
    case 'delete_sso': {
      const result = await deleteSsoUser(ssoUser);
      if (!result.deleted) throw new Error(`SSO user "${ssoUser}" was not found.`);
      return { warning: result.warning };
    }
  }
}

async function runBatchResultRow(ssoUser: string, input: SsoUserBatchRequest): Promise<SsoUserBatchRow> {
  try {
    const outcome = await runSsoUserBatchRow(ssoUser, input);
    return { ssoUser, status: 'success', detail: batchSuccessDetail(input.operation), user: outcome.user, warning: outcome.warning };
  } catch (err) {
    return { ssoUser, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function uniqueSsoUsers(ssoUsers: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ssoUsers) {
    const ssoUser = raw.trim();
    const key = ssoUser.toLowerCase();
    if (!ssoUser || seen.has(key)) continue;
    seen.add(key);
    result.push(ssoUser);
  }
  return result;
}

function batchSuccessDetail(operation: SsoUserBatchRequest['operation']): string {
  switch (operation) {
    case 'sync_emu':
      return 'Synced to EMU and assigned Copilot seat.';
    case 'assign_copilot':
      return 'Assigned Copilot seat.';
    case 'remove_copilot':
      return 'Removed Copilot seat.';
    case 'suspend_emu':
      return 'Suspended in EMU.';
    case 'delete_emu':
      return 'Deleted EMU provisioning data.';
    case 'delete_sso':
      return 'Deleted local SSO user.';
  }
}

async function assignCopilotSeatForUser(user: SsoUserRecord, ghLogin = user.ghLogin): Promise<SsoUserRecord> {
  if (!ghLogin?.trim()) {
    const message = `SSO user "${user.ssoUser}" is not synced to a GH login.`;
    const updated = updateCopilotSeat(user.ssoUser, { status: 'assign_failed', lastOperation: 'assign', lastError: message });
    logger.warn('assign-copilot-seat-missing-gh-login', 'Cannot assign Copilot seat without GH login', { ssoUser: updated.ssoUser });
    throw new Error(message);
  }
  try {
    await assignCopilotSeat(ghLogin);
    return updateCopilotSeat(user.ssoUser, { status: 'assigned', lastOperation: 'assign' });
  } catch (err) {
    const updated = updateCopilotSeat(user.ssoUser, { status: 'assign_failed', lastOperation: 'assign', lastError: errorMessage(err) });
    logger.error('assign-copilot-seat-failed', 'Failed to assign GitHub Copilot seat', { ssoUser: updated.ssoUser, ghLogin, ...errorFields(err) });
    throw err;
  }
}

async function removeCopilotSeatForUser(user: SsoUserRecord): Promise<CopilotSeatRemovalOutcome> {
  if (!user.ghLogin) {
    logger.info('remove-copilot-seat-skipped', 'SSO user has no GH login for Copilot seat removal', { ssoUser: user.ssoUser });
    return { user: updateCopilotSeat(user.ssoUser, { status: 'unassigned', lastOperation: 'remove' }) };
  }
  try {
    await removeCopilotSeat(user.ghLogin);
    return { user: updateCopilotSeat(user.ssoUser, { status: 'unassigned', lastOperation: 'remove' }) };
  } catch (err) {
    if (err instanceof CopilotSeatNotAssignedError) {
      const warning = `GitHub user "${user.ghLogin}" has no Copilot seat; seat removal was skipped.`;
      const updated = updateCopilotSeat(user.ssoUser, { status: 'unassigned', lastOperation: 'remove' });
      logger.warn('remove-copilot-seat-not-assigned', warning, {
        ssoUser: updated.ssoUser,
        ghLogin: user.ghLogin,
        githubStatus: err.status,
      });
      return { user: updated, warning };
    }
    const updated = updateCopilotSeat(user.ssoUser, { status: 'remove_failed', lastOperation: 'remove', lastError: errorMessage(err) });
    logger.error('remove-copilot-seat-failed', 'Failed to remove GitHub Copilot seat', { ssoUser: updated.ssoUser, ghLogin: user.ghLogin, ...errorFields(err) });
    throw err;
  }
}

function enterpriseRoleForSsoUser(user: SsoUserRecord): ScimEnterpriseRole {
  return user.role === 'admin' ? 'enterprise_owner' : 'user';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadScimUsersForImport(targetSsoUser: string | undefined): Promise<ScimUserResource[]> {
  if (!targetSsoUser) return listScimUsers();
  const byUserName = await findScimUserByUsername(targetSsoUser);
  if (byUserName) return [byUserName];
  const target = targetSsoUser.toLowerCase();
  return (await listScimUsers()).filter((scimUser) => {
    const ssoUser = ssoUserFromScimUser(scimUser).toLowerCase();
    const ghLogin = ghLoginFromScimUser(scimUser, ssoUser).toLowerCase();
    return ssoUser === target || ghLogin === target || scimUser.userName.toLowerCase() === target || scimUser.externalId?.toLowerCase() === target;
  });
}

function listAllStoredEmuImportPlanRows(planId: string): ImportEmuUserRow[] {
  const rows: ImportEmuUserRow[] = [];
  for (let page = 1; ; page += 1) {
    const result = listStoredEmuImportPlanRows(planId, { page, pageSize: 500 });
    rows.push(...result.items);
    if (rows.length >= result.total || result.items.length === 0) return rows;
  }
}

function buildEmuImportPlan(scimUsers: ScimUserResource[], assignedCopilotGhLogins: ReadonlySet<string>, emailDomain: string): PlannedEmuImportRow[] {
  const candidates = scimUsers.map((scimUser) => toPlannedCandidate(scimUser, assignedCopilotGhLogins, emailDomain));
  const duplicateSsoUsers = duplicateValues(candidates.filter(hasScimUser).map((row) => row.ssoUser));
  const localUsers = listAllUsers();
  const localBySsoUser = new Map(localUsers.map((user) => [user.ssoUser.toLowerCase(), user]));
  const localByScimId = new Map(localUsers.filter((user) => user.ghScimId).map((user) => [user.ghScimId!, user]));
  return candidates.map((candidate) => {
    if (!candidate.scimUser || candidate.status === 'failed') return candidate;
    if (duplicateSsoUsers.has(candidate.ssoUser)) {
      return { ...withoutAction(candidate), status: 'conflict', detail: `Multiple GH SCIM users map to SSO user "${candidate.ssoUser}".` };
    }
    const existing = localBySsoUser.get(candidate.ssoUser.toLowerCase());
    const boundLocalUser = localByScimId.get(candidate.ghScimId!);
    if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== candidate.ssoUser.toLowerCase()) {
      return {
        ...withoutAction(candidate),
        status: 'conflict',
        detail: `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Rename is not applied automatically.`,
      };
    }
    if (existing?.ghScimId && existing.ghScimId !== candidate.ghScimId) {
      return {
        ...withoutAction(candidate),
        status: 'conflict',
        detail: `SSO user is already bound to different GH SCIM id "${existing.ghScimId}".`,
      };
    }
    if (!existing) {
      return {
        ...candidate,
        action: 'create',
        status: 'pending_create',
        detail: `Will create SSO user using the configured default password policy. Copilot seat: ${candidate.copilotSeatStatus}.`,
      };
    }
    if (isAlreadyAligned(existing, candidate)) {
      return { ...candidate, action: 'skip', status: 'skipped', detail: 'SSO user and Copilot seat are already aligned with GH.' };
    }
    return {
      ...candidate,
      action: 'update',
      status: 'pending_update',
      detail: `Will update local GH metadata and Copilot seat status to ${candidate.copilotSeatStatus}.`,
    };
  });
}

function toPlannedCandidate(scimUser: ScimUserResource, assignedCopilotGhLogins: ReadonlySet<string>, emailDomain: string): PlannedEmuImportRow {
  if (!scimUser.id) {
    return {
      ssoUser: ssoUserFromScimUser(scimUser),
      status: 'failed',
      detail: `GH SCIM user "${scimUser.userName}" does not include an id.`,
    };
  }
  const rawSsoUser = ssoUserFromScimUser(scimUser);
  const ssoUser = sanitizeSsoUser(rawSsoUser);
  if (!ssoUser) {
    return {
      ssoUser: rawSsoUser || scimUser.externalId || scimUser.userName,
      ghLogin: ghLoginFromScimUser(scimUser, rawSsoUser),
      ghScimId: scimUser.id,
      status: 'failed',
      detail: `GH SCIM user "${scimUser.userName}" cannot be mapped to an SSO user.`,
    };
  }
  const ghLogin = ghLoginFromScimUser(scimUser, ssoUser);
  const emuStatus = scimUser.active === false ? 'suspended' : 'active';
  const copilotSeatStatus = assignedCopilotGhLogins.has(ghLogin.toLowerCase()) ? 'assigned' : 'unassigned';
  return {
    ssoUser,
    email: primaryEmail(scimUser) || `${ssoUser}@${emailDomain}`,
    ghLogin,
    ghScimId: scimUser.id,
    emuStatus,
    copilotSeatStatus,
    status: 'pending_update',
    detail: '',
    scimUser,
  };
}

function applyStoredEmuImportRow(row: EmuImportPlanRowRecord, localBySsoUser: Map<string, SsoUserRecord>, localByScimId: Map<string, SsoUserRecord>): EmuImportPlanRowRecord {
  const staleConflict = staleConflictForRow(row, localBySsoUser, localByScimId);
  if (staleConflict) return { ...row, action: undefined, status: 'conflict', detail: staleConflict };
  return { ...applyEmuImportRow({ ...row, scimUser: undefined }), rowIndex: row.rowIndex, action: undefined };
}

function applyEmuImportRow(row: PlannedEmuImportRow): ImportEmuUserRow {
  if (row.action === 'skip' || row.status === 'conflict' || row.status === 'failed') return toImportRow(row);
  if (!row.ghScimId || !row.ghLogin || !row.email || !row.emuStatus || !row.copilotSeatStatus) {
    return { ...toImportRow(row), status: 'failed', detail: 'Import plan row is incomplete.' };
  }
  if (row.action === 'create') {
    const password = resolveInitialPassword(row.ssoUser);
    const { passwordHash, salt } = hashPassword(password);
    const created = createUser({ ssoUser: row.ssoUser, passwordHash, salt, email: row.email, role: 'user' });
    updateEmu(created.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    const updated = updateCopilotSeatFromGitHub(created.ssoUser, row.copilotSeatStatus);
    appendUserEvent('import_emu_create', updated);
    logger.info('import-emu-user-created', 'Recreated SSO user from GH SCIM user', { ssoUser: row.ssoUser, ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    return {
      ...toImportRow(row),
      email: updated.email,
      ghLogin: updated.ghLogin,
      ghScimId: updated.ghScimId,
      emuStatus: updated.emuStatus,
      status: 'created',
      copilotSeatStatus: row.copilotSeatStatus,
      detail: `Created SSO user using the configured default password policy. Copilot seat: ${updated.copilotSeatStatus}.`,
    };
  }
  if (row.action === 'update') {
    updateUser(row.ssoUser, { email: row.email });
    updateEmu(row.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    const updated = updateCopilotSeatFromGitHub(row.ssoUser, row.copilotSeatStatus);
    logger.info('import-emu-user-updated', 'Updated SSO user from GH SCIM user', { ssoUser: row.ssoUser, ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    return {
      ...toImportRow(row),
      email: updated.email,
      ghLogin: updated.ghLogin,
      ghScimId: updated.ghScimId,
      emuStatus: updated.emuStatus,
      status: 'updated',
      copilotSeatStatus: row.copilotSeatStatus,
      detail: `Updated SSO user from GH SCIM. Copilot seat: ${updated.copilotSeatStatus}.`,
    };
  }
  return { ...toImportRow(row), status: 'failed', detail: 'Import plan row has no applicable action.' };
}

function staleConflictForRow(row: EmuImportPlanRowRecord, localBySsoUser: Map<string, SsoUserRecord>, localByScimId: Map<string, SsoUserRecord>): string | undefined {
  if (!row.ghScimId || !row.ghLogin || !row.email || !row.emuStatus || !row.copilotSeatStatus) return 'Import plan row is incomplete.';
  const existing = localBySsoUser.get(row.ssoUser.toLowerCase());
  const boundLocalUser = localByScimId.get(row.ghScimId);
  if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== row.ssoUser.toLowerCase()) {
    return `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Preview again before applying.`;
  }
  if (existing?.ghScimId && existing.ghScimId !== row.ghScimId) {
    return `SSO user is already bound to different GH SCIM id "${existing.ghScimId}". Preview again before applying.`;
  }
  if (row.action === 'create' && existing) return 'SSO user now exists. Preview again before applying.';
  if (row.action === 'update' && !existing) return 'SSO user disappeared after preview. Preview again before applying.';
  return undefined;
}

function toImportRow(row: PlannedEmuImportRow): ImportEmuUserRow {
  return {
    ssoUser: row.ssoUser,
    email: row.email,
    ghLogin: row.ghLogin,
    ghScimId: row.ghScimId,
    emuStatus: row.emuStatus,
    copilotSeatStatus: row.copilotSeatStatus,
    status: row.status,
    detail: row.detail,
  };
}

function withoutAction(row: PlannedEmuImportRow): PlannedEmuImportRow {
  return { ...row, action: undefined };
}

function withoutScimUser(row: PlannedEmuImportRow): Omit<EmuImportPlanRowRecord, 'rowIndex'> {
  const { scimUser: _scimUser, ...stored } = row;
  return stored;
}

function hasScimUser(row: PlannedEmuImportRow): boolean {
  return Boolean(row.scimUser);
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function isAlreadyAligned(existing: SsoUserRecord, row: PlannedEmuImportRow): boolean {
  return existing.email === row.email
    && existing.ghLogin === row.ghLogin
    && existing.ghScimId === row.ghScimId
    && existing.emuStatus === row.emuStatus
    && existing.copilotSeatStatus === row.copilotSeatStatus;
}

function batchResult(startedAt: string, rows: ImportEmuUserRow[]): BatchResult<ImportEmuUserRow> {
  const counts = summaryCounts(rows);
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: counts.success, skipped: counts.skipped, failed: counts.failed },
    rows,
  };
}

function summaryCounts(rows: ImportEmuUserRow[]): { success: number; skipped: number; failed: number } {
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  const failed = rows.filter((row) => row.status === 'failed' || row.status === 'conflict').length;
  return { success: rows.length - skipped - failed, skipped, failed };
}

function ssoUserFromScimUser(scimUser: ScimUserResource): string {
  return scimUser.userName || scimUser.externalId || '';
}

function ghLoginFromScimUser(scimUser: ScimUserResource, ssoUser: string): string {
  return scimUser.githubLogin || normalizeHandle(ssoUser || scimUser.userName, config.enterpriseShortcode);
}

function primaryEmail(scimUser: ScimUserResource): string | undefined {
  return scimUser.emails?.find((email) => email.primary)?.value ?? scimUser.emails?.[0]?.value;
}

function nextAvailableSsoUser(raw: string, userPrefix: string): string {
  const base = sanitizeSsoUser(raw) || userPrefix;
  if (!getUser(base)) return base;
  for (let i = 2; i < 100_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!getUser(candidate)) return candidate;
  }
  const count = listAllUsers().length + 1;
  return `${userPrefix}${count}`;
}

function sanitizeSsoUser(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function ssoUserFromEnsureInput(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized).slice(0, 32);
}

function ensureSsoUserCandidates(identity: string, preferredSsoUser?: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [preferredSsoUser, identity]) {
    if (typeof raw !== 'string') continue;
    const ssoUser = ssoUserFromEnsureInput(raw);
    const key = ssoUser.toLowerCase();
    if (!ssoUser || seen.has(key)) continue;
    seen.add(key);
    candidates.push(ssoUser);
  }
  return candidates;
}

function findExistingEnsureUser(identity: string, preferredSsoUser: string | undefined, ssoUserCandidates: string[]): SsoUserRecord | undefined {
  for (const ssoUser of ssoUserCandidates) {
    const user = getUser(ssoUser);
    if (user) return user;
  }
  for (const ghLogin of ensureGhLoginCandidates(identity, preferredSsoUser)) {
    const user = getUserByGhLogin(ghLogin);
    if (user) return user;
  }
  return undefined;
}

function ensureGhLoginCandidates(identity: string, preferredSsoUser?: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [identity, preferredSsoUser]) {
    if (typeof raw !== 'string') continue;
    const ghLogin = raw.trim();
    const key = ghLogin.toLowerCase();
    if (!ghLogin || seen.has(key)) continue;
    seen.add(key);
    candidates.push(ghLogin);
  }
  return candidates;
}

function stripEnterpriseShortcode(value: string): string {
  const shortcode = config.enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}
