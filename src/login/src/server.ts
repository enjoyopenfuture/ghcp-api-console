import express from 'express';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { recoverInterruptedTasks } from './db/tasksRepo.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { tasksApiRouter } from './routes/tasksApi.js';
import { settingsApiRouter } from './routes/settingsApi.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'login' });
  });
  app.use('/api', requireInternalToken, tasksApiRouter, settingsApiRouter);
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'Login route is not implemented yet.'));
  });
  return app;
}

export function startServer(): void {
  getDb();
  recoverInterruptedTasks();
  buildApp().listen(config.port, () => {
    console.log(`[login] listening on http://localhost:${config.port}`);
  });
}
