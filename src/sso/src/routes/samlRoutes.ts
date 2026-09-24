import { Router } from 'express';
import { getUser } from '../db/usersRepo.js';
import { verifyPassword } from '../auth/password.js';
import { buildSamlResponse, metadataXml, parseAuthnRequest } from '../saml/saml.js';

interface IdpSession {
  user?: { ssoUser: string };
  pendingInResponseTo?: string;
  pendingRelayState?: string;
  ssoPending?: boolean;
}

export const samlRouter = Router();

samlRouter.get('/metadata', (_req, res) => {
  res.type('application/xml').send(metadataXml());
});

samlRouter.get('/sso', async (req, res) => {
  try {
    const session = sess(req);
    if (req.query.SAMLRequest) {
      const parsed = await parseAuthnRequest(req.query as Record<string, unknown>);
      session.pendingInResponseTo = parsed.id;
      session.pendingRelayState = parsed.relayState;
      if (parsed.forceAuthn) session.user = undefined;
    } else {
      session.pendingInResponseTo = undefined;
      session.pendingRelayState = typeof req.query.RelayState === 'string' ? req.query.RelayState : undefined;
    }
    session.ssoPending = true;
    if (!session.user) {
      res.redirect('/login');
      return;
    }
    await respondSaml(req, res);
  } catch (err) {
    res.status(400).send(`Invalid SAML request: ${(err as Error).message}`);
  }
});

samlRouter.get('/login', (_req, res) => {
  res.type('html').send(loginHtml());
});

samlRouter.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const user = username ? getUser(username) : undefined;
  if (!user || !(await verifyPassword(password ?? '', user.passwordHash, user.salt))) {
    res.status(401).type('html').send(loginHtml('Invalid username or password.'));
    return;
  }
  sess(req).user = { ssoUser: user.ssoUser };
  if (sess(req).ssoPending) {
    await respondSaml(req, res);
    return;
  }
  res.type('html').send(`<p>Logged in as ${escapeHtml(user.ssoUser)}</p><form method="post" action="/logout"><button>Logout</button></form>`);
});

samlRouter.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

async function respondSaml(req: import('express').Request, res: import('express').Response): Promise<void> {
  const ssoUser = sess(req).user?.ssoUser;
  const user = ssoUser ? getUser(ssoUser) : undefined;
  if (!user) {
    req.session = null;
    res.redirect('/login');
    return;
  }
  const post = await buildSamlResponse(user, sess(req).pendingInResponseTo, sess(req).pendingRelayState);
  sess(req).pendingInResponseTo = undefined;
  sess(req).pendingRelayState = undefined;
  sess(req).ssoPending = false;
  res.type('html').send(samlPostHtml(post.acsUrl, post.samlResponse, post.relayState));
}

function sess(req: import('express').Request): IdpSession {
  return req.session as unknown as IdpSession;
}

function loginHtml(error?: string): string {
  return `<!doctype html><html><body><main><h1>SSO Login</h1>${error ? `<p style="color:red">${escapeHtml(error)}</p>` : ''}<form method="post" action="/login"><label>Username <input name="username" autocomplete="username"></label><br><label>Password <input name="password" type="password" autocomplete="current-password"></label><br><button type="submit">Sign in</button></form></main></body></html>`;
}

function samlPostHtml(acsUrl: string, samlResponse: string, relayState: string): string {
  return `<!doctype html><html><body onload="document.forms[0].submit()"><form method="post" action="${escapeHtml(acsUrl)}"><input type="hidden" name="SAMLResponse" value="${escapeHtml(samlResponse)}"><input type="hidden" name="RelayState" value="${escapeHtml(relayState)}"><noscript><button type="submit">Continue</button></noscript></form></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
