import { Router } from 'express';
import { apiError } from '@ghcp/shared';
import { getUser } from '../db/usersRepo.js';
import { knownDefaultPasswordForUserAsync } from '../users/passwordPolicy.js';

export const loginCredentialsRouter = Router();
let resolving = 0;

loginCredentialsRouter.post('/users/:ssoUser/login-credentials', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = getUser(req.params.ssoUser);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'The existing SSO user was not found.'));
    return;
  }
  if (resolving >= 4) {
    res.setHeader('Retry-After', '1');
    res.status(429).json(apiError('default_credentials_busy', 'Default credential checks are busy; retry this account shortly.'));
    return;
  }
  resolving++;
  let password: string | undefined;
  try { password = await knownDefaultPasswordForUserAsync(user); }
  finally { resolving--; }
  if (!password) {
    res.status(409).json(apiError('password_override_required', 'This account no longer uses a known default password. Provide an override for this account.'));
    return;
  }
  res.json({ ssoUser: user.ssoUser, password });
});
