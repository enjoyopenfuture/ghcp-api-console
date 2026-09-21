import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler } from 'express';
import type { PageResponse } from './api.js';
import { csvRow, readManagementQuery, type ManagementQuery } from './management.js';
import { HttpApiError } from './api.js';
import { resolveOperationSelection } from './operations.js';

export function csvExport<T>(
  name: string, columns: string[],
  list: (query: ManagementQuery) => Promise<PageResponse<T>>, values: (item: T) => unknown[],
  snapshot?: (query: ManagementQuery, consume: (read: typeof list) => Promise<void>) => Promise<void>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const selected = req.method === 'POST';
      const pageOnly = req.query.scope === 'page';
      const query = { ...readManagementQuery(req.query), asOf: new Date().toISOString() };
      const consume = async (read: typeof list) => {
        const ids = selected ? await resolveOperationSelection(req.body?.selection, read, (item) => String(values(item)[0])) : undefined;
        if (ids && !ids.length) throw new HttpApiError(400, 'empty_selection', 'No selected records remain.');
        const sourceQuery = ids ? { ids, sort: query.sort, dir: query.dir } : query;
        const first = await read(pageOnly ? sourceQuery : { ...sourceQuery, page: 1, pageSize: 100 });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Export-Matched-At-Start', String(pageOnly ? first.items.length : first.total));
        async function* rows() {
          yield '\ufeff' + csvRow(columns);
          let result = first;
          for (let page = 1; ; page++) {
            if (res.destroyed) return;
            if (page > 1) result = await read({ ...sourceQuery, page, pageSize: 100 });
            if (!pageOnly && result.page !== page) throw new Error('Export snapshot pagination changed unexpectedly.');
            for (const row of result.items) yield csvRow(values(row));
            if (pageOnly || page * result.pageSize >= result.total) return;
          }
        }
        await pipeline(Readable.from(rows()), res);
      };
      if (snapshot) await snapshot(query, consume);
      else await consume(list);
    } catch (err) {
      // Once the CSV header has been flushed the response cannot be turned into a JSON error.
      // Destroy it so the client's fetch rejects instead of resolving with a silently short file.
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      next(err);
    }
  };
}
