import express from 'express';
import cookieSession from 'cookie-session';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { usersApiRouter } from './routes/usersApi.js';
import { budgetApiRouter } from './routes/budgetApi.js';
import { samlRouter } from './routes/samlRoutes.js';
import { settingsApiRouter } from './routes/settingsApi.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieSession({ name: 'sso_session', secret: config.sessionSecret, httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'sso' });
  });
  app.use(samlRouter);
  app.use('/api', requireInternalToken, settingsApiRouter, usersApiRouter, budgetApiRouter);
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'SSO route is not implemented yet.'));
  });
  return app;
}

export function startServer(): void {
  getDb();
  const server = buildApp().listen(config.port, () => {
    console.log(`[sso] listening on ${config.baseUrl}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sso] failed to listen on port ${config.port}: address already in use`);
      process.exitCode = 1;
      return;
    }
    throw err;
  });
}
