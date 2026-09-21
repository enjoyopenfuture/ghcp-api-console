import { HttpApiError, LIKE_ESCAPE_CLAUSE, likeContains, type ManagementQuery } from '@ghcp/shared';

export function managementSql(kind: 'accounts' | 'requests', query: ManagementQuery, timestamp: (value: string) => string = (value) => value) {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => { clauses.push(sql); args.push(...values); };
  if (query.ids?.length) add(`${kind === 'accounts' ? 'identity' : 'id'} IN (${query.ids.map(() => '?').join(',')})`, ...query.ids);
  const fields = kind === 'accounts' ? ['identity', 'sso_user', 'gh_login'] : ['identity', 'gh_login', 'model', 'failure_reason'];
  // Wildcards in the search term are escaped: a raw `_` otherwise matches any character, so
  // searching for `user_1` quietly returns `user-1` as well.
  if (query.q) add(`(${fields.map((field) => `LOWER(${field}) LIKE LOWER(?) ${LIKE_ESCAPE_CLAUSE}`).join(' OR ')})`, ...fields.map(() => likeContains(query.q!)));
  if (query.identity) add('identity = ?', query.identity);
  if (query.model && kind === 'requests') add(`LOWER(model) LIKE LOWER(?) ${LIKE_ESCAPE_CLAUSE}`, likeContains(query.model));
  if (query.success && kind === 'requests') {
    if (query.success !== 'true' && query.success !== 'false') throw new HttpApiError(400, 'invalid_outcome', 'success must be true or false.');
    add('success = ?', query.success === 'true' ? 1 : 0);
  }
  if (query.status && kind === 'accounts') {
    const statuses = query.status.split(',');
    if (statuses.some((status) => !['valid', 'expired', 'missing', 'refreshing', 'failed'].includes(status))) throw new HttpApiError(400, 'invalid_status', 'Invalid OAuth status.');
    add(`copilot_oauth_status IN (${statuses.map(() => '?').join(',')})`, ...statuses);
  }
  const timeColumn = kind === 'accounts' ? 'updated_at' : 'requested_at';
  if (query.from) add(`${timeColumn} >= ?`, timestamp(query.from));
  if (query.to) add(`${timeColumn} < ?`, timestamp(query.to));
  const sorts: Record<string, string> = kind === 'accounts'
    ? { identity: 'identity', ssoUser: 'sso_user', ghLogin: 'gh_login', copilotOauthStatus: 'copilot_oauth_status', createdAt: 'created_at', updatedAt: 'updated_at' }
    : { requestedAt: 'requested_at', identity: 'identity', model: 'model', success: 'success', inputTokens: 'input_tokens', outputTokens: 'output_tokens' };
  const sortKey = query.sort ?? (kind === 'accounts' ? 'updatedAt' : 'requestedAt');
  const sort = Object.hasOwn(sorts, sortKey) ? sorts[sortKey] : undefined;
  if (!sort) throw new HttpApiError(400, 'invalid_sort', 'Unknown sort field.');
  const direction = query.dir === 'asc' ? 'ASC' : 'DESC';
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args, order: `${sort} ${direction}, ${kind === 'accounts' ? 'identity' : 'id'} ${direction}` };
}
