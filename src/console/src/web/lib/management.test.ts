import assert from 'node:assert/strict';
import test from 'node:test';
import { filterKey, listQueryString, matchesSelection, readListQuery, selectionForQuery } from './management.js';

test('list view state round-trips without changing multi-status filters or pagination', () => {
  const query = readListQuery('#tasks?status=pending%2Crunning&page=3&pageSize=50&q=account%2B1&minAttempts=2');
  assert.equal(query.status, 'pending,running');
  assert.equal(query.q, 'account+1');
  assert.equal(query.page, 3);
  assert.equal(query.pageSize, 50);
  assert.equal(query.minAttempts, 2);
  assert.deepEqual(readListQuery(`#tasks?${listQueryString(query)}`), query);
  assert.equal(filterKey({ ...query, page: 4, pageSize: 100, sort: 'status' }), filterKey(query));
  assert.notEqual(filterKey({ ...query, status: 'failed' }), filterKey(query));
});

test('selection retains IDs across pages and distinguishes exclusions from explicit selection', () => {
  const ids = new Set(['first-page-item', 'second-page-item']);
  assert.equal(matchesSelection('first-page-item', ids, false), true);
  assert.equal(matchesSelection('other-item', ids, false), false);
  assert.deepEqual(selectionForQuery({ status: 'failed' }, ids, false), { ids: [...ids] });
  assert.equal(matchesSelection('first-page-item', ids, true), false);
  assert.equal(matchesSelection('other-item', ids, true), true);
  assert.deepEqual(selectionForQuery({ status: 'failed' }, ids, true), { query: { status: 'failed' }, excludedIds: [...ids] });
  assert.equal(readListQuery('#tasks?page=-1&pageSize=999').pageSize, 25);
});

test('query serialization is canonical across edits and hash restoration', () => {
  const edited = { page: 1, pageSize: 25, status: 'failed', q: 'user' };
  const restored = readListQuery(`#tasks?${listQueryString(edited)}`);
  assert.equal(listQueryString(edited), listQueryString(restored));
  assert.equal(listQueryString({ q: 'user', status: 'failed', pageSize: 25, page: 1 }), listQueryString(edited));
});
