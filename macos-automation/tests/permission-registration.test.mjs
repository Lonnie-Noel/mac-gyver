import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('native permission resets stay scoped and refuse active, pending, or uncertain work',
  { skip: process.platform !== 'darwin' }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'macgyver-permissions-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const executable = path.join(temp, 'permission-registration-tests');
    await execute('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
      path.join(root, 'native/PermissionRegistration.swift'),
      path.join(root, 'tests/native/PermissionRegistrationTests.swift'), '-o', executable],
    { timeout: 120000 });
    const { stdout } = await execute(executable, [], { timeout: 10000 });
    assert.match(stdout, /regression checks passed \(mock resets only\)/);
  });
