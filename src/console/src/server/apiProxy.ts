import type { Request, Response } from 'express';
import { apiError, errorFields, INTERNAL_AUTH_HEADER, loggerFor } from '@ghcp/shared';
import { config } from './config.js';

const logger = loggerFor('console', 'api-proxy');

export function serviceProxy(target: 'proxy' | 'sso' | 'login', mountPath: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const baseUrl = targetBaseUrl(target);
    const suffix = req.originalUrl.slice(mountPath.length) || '/';
    const url = `${baseUrl.replace(/\/+$/, '')}/api${suffix}`;
    const startedAt = Date.now();
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
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      const contentDisposition = upstream.headers.get('content-disposition');
      if (contentType) res.setHeader('Content-Type', contentType);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      res.send(body);
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
      res.status(502).json(apiError('service_proxy_failed', err instanceof Error ? err.message : String(err)));
    }
  };
}

function targetBaseUrl(target: 'proxy' | 'sso' | 'login'): string {
  if (target === 'proxy') return config.proxyBaseUrl;
  if (target === 'sso') return config.ssoBaseUrl;
  return config.loginBaseUrl;
}
