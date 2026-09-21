import type { Request, Response } from 'express';
import { apiError, errorFields, INTERNAL_AUTH_HEADER, loggerFor } from '@ghcp/shared';
import { config } from './config.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const logger = loggerFor('console', 'api-proxy');

export function serviceProxy(target: 'proxy' | 'sso' | 'login', mountPath: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const baseUrl = targetBaseUrl(target);
    const suffix = req.originalUrl.slice(mountPath.length) || '/';
    const url = `${baseUrl.replace(/\/+$/, '')}/api${suffix}`;
    let decodedPath = suffix.split('?')[0]!;
    for (let pass = 0; pass < 5; pass++) {
      try {
        const next = decodeURIComponent(decodedPath);
        if (next === decodedPath) break;
        decodedPath = next;
      } catch (err) {
        // A percent sign decoded from a valid path is a literal identifier character.
        if (pass > 0 && err instanceof URIError) break;
        res.status(400).json(apiError('invalid_proxy_path', 'The service path is invalid.'));
        return;
      }
    }
    if (decodedPath.split(/[\\/]/).some((part) => part === '.' || part === '..')
      || !new URL(url).pathname.startsWith(new URL(`${baseUrl.replace(/\/+$/, '')}/api/`).pathname)) {
      res.status(400).json(apiError('invalid_proxy_path', 'Only public service API paths may be forwarded.'));
      return;
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    logger.info('proxy-request', 'Forwarding console API request', {
      target,
      method: req.method,
      suffix,
    });
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: {
          Accept: req.get('accept') ?? 'application/json',
          'Content-Type': 'application/json',
          [INTERNAL_AUTH_HEADER]: config.internalApiToken,
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
        signal: controller.signal,
      });
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      const contentDisposition = upstream.headers.get('content-disposition');
      if (contentType) res.setHeader('Content-Type', contentType);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      if (upstream.headers.has('cache-control')) res.setHeader('Cache-Control', upstream.headers.get('cache-control')!);
      if (upstream.headers.has('x-export-matched-at-start')) res.setHeader('X-Export-Matched-At-Start', upstream.headers.get('x-export-matched-at-start')!);
      if (upstream.body && (contentDisposition || contentType?.includes('text/csv'))) {
        const body = upstream.body;
        async function* chunks() {
          const reader = body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) return;
              yield value;
            }
          } finally { reader.releaseLock(); }
        }
        await pipeline(Readable.from(chunks()), res);
      } else {
        res.send(Buffer.from(await upstream.arrayBuffer()));
      }
      logger.info('proxy-response', 'Console API request completed', {
        target,
        method: req.method,
        suffix,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.error('proxy-failed', 'Console API request failed', {
        target,
        method: req.method,
        suffix,
        durationMs: Date.now() - startedAt,
        ...errorFields(err),
      });
      if (!res.headersSent && !res.destroyed) {
        // Headers copied from the upstream response describe a CSV attachment that will never be
        // sent. Leaving them on turns the JSON error into a downloaded file named like the export.
        for (const header of ['Content-Disposition', 'X-Export-Matched-At-Start', 'Cache-Control']) res.removeHeader(header);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(502).json(apiError('service_proxy_failed', err instanceof Error ? err.message : String(err)));
      }
    } finally {
      res.removeListener('close', abort);
    }
  };
}

function targetBaseUrl(target: 'proxy' | 'sso' | 'login'): string {
  if (target === 'proxy') return config.proxyBaseUrl;
  if (target === 'sso') return config.ssoBaseUrl;
  return config.loginBaseUrl;
}
