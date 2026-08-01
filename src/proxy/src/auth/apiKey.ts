import type { NextFunction, Request, Response } from 'express';
import { apiError } from '@ghcp/shared';
import { config } from '../config.js';

declare module 'express-serve-static-core' {
  interface Request {
    identity?: string;
    rawBody?: Buffer;
  }
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const presented = extractApiKey(req);
  if (!presented) {
    res.status(401).json(apiError('missing_api_key', 'Missing API key. Use Authorization: Bearer or x-api-key.'));
    return;
  }
  if (!config.apiKey || presented !== config.apiKey) {
    res.status(401).json(apiError('invalid_api_key', 'Invalid API key.'));
    return;
  }
  next();
}

function extractApiKey(req: Request): string | undefined {
  const xApiKey = req.header('x-api-key');
  if (xApiKey) return xApiKey;
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}
