import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { changeAdminPassword, setupAdmin, verifyAdmin } from './adminsStore.js';
import { config } from './config.js';

test('changes the active administrator password after verifying the current password', async () => {
  const originalAdminsFile = config.adminsFile;
  const adminsFile = resolve(process.cwd(), 'data', 'admins-store-tests', `${randomUUID()}.json`);
  config.adminsFile = adminsFile;

  try {
    setupAdmin('admin', 'old-password');
    assert.ok(verifyAdmin('admin', 'old-password'));
    assert.equal(changeAdminPassword('admin', 'wrong-password', 'new-password'), false);
    assert.ok(verifyAdmin('admin', 'old-password'));

    assert.equal(changeAdminPassword('admin', 'old-password', 'new-password'), true);
    assert.equal(verifyAdmin('admin', 'old-password'), undefined);
    assert.ok(verifyAdmin('admin', 'new-password'));
    assert.throws(
      () => changeAdminPassword('admin', 'new-password', ''),
      /currentPassword and newPassword are required/,
    );
  } finally {
    config.adminsFile = originalAdminsFile;
    await rm(dirname(adminsFile), { recursive: true, force: true });
  }
});
