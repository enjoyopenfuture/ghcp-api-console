import type { BatchResult, ImportCopilotOauthTokenRow } from '@ghcp/shared';
import { HttpApiError, newBatchId, nowIso } from '@ghcp/shared';
import { getSsoUser } from '../clients/ssoClient.js';
import { clearModelsCache, CopilotApiError, validateCopilotOauthToken } from '../copilot/copilotClient.js';
import { importCopilotOauthToken, toAccountDto } from '../db/accountsRepo.js';

interface ImportRow {
  line: number;
  name: string;
  copilotOauthToken: string;
}

interface ParseError {
  line: number;
  name: string;
  error: string;
}

export async function importCopilotOauthTokens(csvText: string): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  const startedAt = nowIso();
  const parsed = parseCopilotOauthTokenCsv(csvText);
  const rows: ImportCopilotOauthTokenRow[] = [];
  for (const row of parsed.rows) {
    rows.push(await importCopilotOauthTokenRow(row));
  }
  for (const error of parsed.errors) {
    rows.push({
      line: error.line,
      name: error.name,
      status: 'failed',
      detail: error.error,
    });
  }
  rows.sort((left, right) => left.line - right.line);
  const failed = rows.filter((row) => row.status === 'failed').length;
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, failed },
    rows,
  };
}

async function importCopilotOauthTokenRow(row: ImportRow): Promise<ImportCopilotOauthTokenRow> {
  try {
    const ssoUser = await getSsoUser(row.name);
    await validateCopilotOauthToken(row.name, row.copilotOauthToken);
    const account = await importCopilotOauthToken({
      identity: row.name,
      ssoUser: ssoUser.ssoUser,
      ghLogin: ssoUser.ghLogin ?? row.name,
      copilotOauthToken: row.copilotOauthToken,
    });
    clearModelsCache(row.name);
    return {
      line: row.line,
      name: row.name,
      status: 'success',
      detail: ssoUser.ghLogin
        ? 'Copilot OAuth token was validated and imported.'
        : 'Copilot OAuth token was validated and imported with name as GH login fallback; sync SSO to GH to confirm ghLogin.',
      account: toAccountDto(account),
    };
  } catch (err) {
    return {
      line: row.line,
      name: row.name,
      status: 'failed',
      detail: importErrorMessage(err, row.name),
    };
  }
}

function importErrorMessage(err: unknown, name: string): string {
  if (err instanceof HttpApiError && err.status === 404) return `SSO user "${name}" was not found. Create it manually in SSO Users before importing this token.`;
  if (err instanceof CopilotApiError && err.status === 401) return 'Copilot OAuth token validation failed: token is invalid or expired.';
  if (err instanceof CopilotApiError && err.status === 403) return 'Copilot OAuth token validation failed: account has no Copilot access or is blocked by organization policy.';
  if (err instanceof CopilotApiError) return `Copilot OAuth token validation failed: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function parseCopilotOauthTokenCsv(text: string): { rows: ImportRow[]; errors: ParseError[] } {
  const rows: ImportRow[] = [];
  const errors: ParseError[] = [];
  const seen = new Set<string>();
  let headerChecked = false;
  let headerValid = false;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    if (!rawLine.trim()) return;
    if (headerChecked && !headerValid) return;
    let values: string[];
    try {
      values = parseCsvLine(rawLine);
    } catch (err) {
      errors.push({ line, name: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!headerChecked) {
      headerChecked = true;
      if (!isHeader(values)) {
        errors.push({ line, name: values[0]?.trim() ?? '', error: 'CSV header must be exactly: name,copilotOauthToken' });
        return;
      }
      headerValid = true;
      return;
    }
    if (values.length !== 2) {
      errors.push({ line, name: values[0]?.trim() ?? '', error: 'Expected two columns: name,copilotOauthToken' });
      return;
    }
    const name = values[0]!.trim();
    const copilotOauthToken = values[1]!.trim();
    if (!name) {
      errors.push({ line, name, error: 'name is required.' });
      return;
    }
    if (!copilotOauthToken) {
      errors.push({ line, name, error: 'copilotOauthToken is required.' });
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line, name, error: `Duplicate name "${name}" in import CSV.` });
      return;
    }
    seen.add(key);
    rows.push({ line, name, copilotOauthToken });
  });
  if (!headerChecked) errors.push({ line: 1, name: '', error: 'CSV header is required: name,copilotOauthToken' });
  return { rows, errors };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quoted) throw new Error('Unclosed quoted value');
  values.push(current);
  return values;
}

function isHeader(values: string[]): boolean {
  return values.length === 2
    && values[0]!.trim() === 'name'
    && values[1]!.trim() === 'copilotOauthToken';
}
