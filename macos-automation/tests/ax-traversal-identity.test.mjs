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

test('native traversal keeps hash collisions distinct and detects equal AX references', { skip: process.platform !== 'darwin' }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'macgyver-ax-traversal-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const executable = path.join(temp, 'ax-traversal-tests');
  await execute('/usr/bin/xcrun', ['swiftc', '-parse-as-library',
    path.join(root, 'native/AXTraversalIdentity.swift'),
    path.join(root, 'tests/native/AXTraversalIdentityTests.swift'), '-o', executable], { timeout: 120000 });
  const { stdout } = await execute(executable, [], { timeout: 10000 });
  assert.match(stdout, /AXTraversalIdentity regression checks passed/);
});
