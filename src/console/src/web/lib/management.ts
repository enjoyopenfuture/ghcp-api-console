import type { ManagementQuery, ManagementSelection } from '@ghcp/shared';

export function readListQuery(hash: string, preferredSize = 25): ManagementQuery {
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const query: ManagementQuery = {};
  for (const key of ['q', 'status', 'from', 'to', 'sort', 'dir', 'identity', 'model', 'success', 'role', 'seatStatus', 'failureCode', 'finishedBefore'] as const) {
    const value = params.get(key);
    if (value && key !== 'dir') query[key] = value;
    if (key === 'dir' && (value === 'asc' || value === 'desc')) query.dir = value;
  }
  const size = Number(params.get('pageSize') ?? preferredSize);
  const page = Number(params.get('page') ?? 1);
  query.pageSize = [10, 25, 50, 100].includes(size) ? size : 25;
  query.page = Number.isSafeInteger(page) && page > 0 ? page : 1;
  for (const key of ['minAttempts', 'minWaitSeconds', 'minRunSeconds'] as const) {
    const value = params.get(key);
    if (value !== null && Number.isSafeInteger(Number(value)) && Number(value) >= 0) query[key] = Number(value);
  }
  return query;
}

export function listQueryString(query: ManagementQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query).sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export function selectionForQuery(query: ManagementQuery, ids: Set<string>, allMatching: boolean): ManagementSelection {
  return allMatching ? { query, excludedIds: [...ids] } : { ids: [...ids] };
}

export function matchesSelection(id: string, ids: Set<string>, allMatching: boolean): boolean {
  return allMatching ? !ids.has(id) : ids.has(id);
}

export function filterKey(query: ManagementQuery): string {
  const { page: _page, pageSize: _size, sort: _sort, dir: _dir, ...filters } = query;
  return JSON.stringify(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '').sort(([a], [b]) => a.localeCompare(b)));
}
