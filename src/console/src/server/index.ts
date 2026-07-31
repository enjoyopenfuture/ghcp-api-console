import { resolve } from 'node:path';
import express from 'express';
import cookieSession from 'cookie-session';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { requireAdmin, session } from './auth.js';
import { changeAdminPassword, isInitialized, setupAdmin, verifyAdmin } from './adminsStore.js';
import { serviceProxy } from './apiProxy.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieSession({ name: 'console_session', secret: config.sessionSecret, httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'console' });
  });
  app.get('/api/console/setup', (_req, res) => {
    res.json({ initialized: isInitialized() });
  });
  app.post('/api/console/setup', (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string };
      const admin = setupAdmin(username ?? '', password ?? '');
      session(req).admin = { username: admin.username, role: admin.role };
      res.status(201).json({ username: admin.username, role: admin.role });
    } catch (err) {
      res.status(400).json(apiError('setup_failed', (err as Error).message));
    }
  });
  app.post('/api/console/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    const admin = verifyAdmin(username ?? '', password ?? '');
    if (!admin) {
      res.status(401).json(apiError('login_failed', 'Invalid username or password.'));
      return;
    }
    session(req).admin = { username: admin.username, role: admin.role };
    res.json({ username: admin.username, role: admin.role });
  });
  app.post('/api/console/logout', (req, res) => {
    req.session = null;
    res.status(204).end();
  });
  app.get('/api/console/me', requireAdmin, (req, res) => {
    res.json(session(req).admin);
  });
  app.patch('/api/console/password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
      res.status(400).json(apiError('invalid_password_change', 'currentPassword and newPassword are required.'));
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json(apiError('invalid_password_change', 'New password must be different from the current password.'));
      return;
    }
    try {
      const username = session(req).admin!.username;
      if (!changeAdminPassword(username, currentPassword, newPassword)) {
        res.status(401).json(apiError('invalid_current_password', 'Current password is incorrect.'));
        return;
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json(apiError('password_change_failed', err instanceof Error ? err.message : String(err)));
    }
  });
  app.use('/api/console/proxy', requireAdmin, serviceProxy('proxy', '/api/console/proxy'));
  app.use('/api/console/sso', requireAdmin, serviceProxy('sso', '/api/console/sso'));
  app.use('/api/console/login-service', requireAdmin, serviceProxy('login', '/api/console/login-service'));
  const staticDir = resolve(process.cwd(), 'dist/web');
  app.use(express.static(staticDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(resolve(staticDir, 'index.html'));
  });
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'Console route is not implemented yet.'));
  });
  return app;
}

buildApp().listen(config.port, () => {
  console.log(`[console] listening on http://localhost:${config.port}`);
});
