export interface BulkImportRow {
  line: number;
  ssoUser: string;
  password?: string;
}

export interface BulkImportError {
  line: number;
  ssoUser?: string;
  error: string;
}

export interface BulkImportParseResult {
  rows: BulkImportRow[];
  errors: BulkImportError[];
}

export function parseBulkImportText(text: string): BulkImportParseResult {
  const rows: BulkImportRow[] = [];
  const errors: BulkImportError[] = [];
  const seen = new Set<string>();
  let headerChecked = false;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    if (!rawLine.trim()) return;
    let values: string[];
    try {
      values = parseCsvLine(rawLine);
    } catch (err) {
      errors.push({ line, error: (err as Error).message });
      return;
    }
    if (!headerChecked) {
      headerChecked = true;
      if (isHeader(values)) return;
    }
    if (values.length !== 1 && values.length !== 2) {
      errors.push({ line, error: 'Expected one column ssoUser or two columns: ssoUser,password' });
      return;
    }
    const ssoUser = values[0]!.trim();
    const password = values.length === 2 ? values[1]!.trim() : undefined;
    if (!ssoUser || (values.length === 2 && !password)) {
      errors.push({ line, ssoUser: ssoUser || undefined, error: 'SSO user is required and an explicit password must not be empty' });
      return;
    }
    const key = ssoUser.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line, ssoUser, error: `Duplicate SSO user "${ssoUser}" in import text` });
      return;
    }
    seen.add(key);
    rows.push({ line, ssoUser, password });
  });
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
  if (values.length === 1) return values[0]!.trim().toLowerCase() === 'ssouser' || values[0]!.trim().toLowerCase() === 'sso_user';
  return (values[0]!.trim().toLowerCase() === 'ssouser' || values[0]!.trim().toLowerCase() === 'sso_user') && values[1]!.trim().toLowerCase() === 'password';
}
