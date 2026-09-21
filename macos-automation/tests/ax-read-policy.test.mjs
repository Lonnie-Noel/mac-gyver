import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectors, uniqueNode, readUI } from '../scripts/core.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('native AX reads tolerate optional subrole/description/value failure and preserve critical failures', { skip: process.platform !== 'darwin' }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'macgyver-ax-policy-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const executable = path.join(temp, 'ax-policy-tests');
  await execute('/usr/bin/xcrun', ['swiftc', '-parse-as-library',
    path.join(root, 'native/AXReadPolicy.swift'),
    path.join(root, 'tests/native/AXReadPolicyTests.swift'), '-o', executable], { timeout: 120000 });
  const { stdout } = await execute(executable, [], { timeout: 10000 });
  assert.match(stdout, /regression checks passed/);
});

test('an omitted description cannot match the Tools action or prove Reframe readiness', () => {
  const snapshot = {
    window: { rect: { x: 0, y: 0, width: 800, height: 600 } },
    nodes: [
      { role: 'AXRadioButton', enabled: true },
      { identifier: 'IPXEditModalCancelChanges', enabled: true },
      { role: 'AXStaticText', enabled: true },
    ],
  };
  assert.throws(() => uniqueNode(snapshot, selectors.tools), /\(0\)/);
  assert.equal(readUI(snapshot).reframeReady, false);
  assert.equal(readUI(snapshot).generated, false);
});

test('an omitted scalar value cannot satisfy a value selector or prove Reframe readiness', () => {
  const snapshot = {
    window: { rect: { x: 0, y: 0, width: 800, height: 600 } },
    nodes: [{ role: 'AXStaticText', enabled: true },
      { identifier: 'IPXEditModalCancelChanges', enabled: true }],
  };
  assert.throws(() => uniqueNode(snapshot, { role: 'AXStaticText', value: '드래그하여 시점을 조절하십시오.' }), /\(0\)/);
  assert.equal(readUI(snapshot).reframeReady, false);
  assert.equal(readUI(snapshot).generated, false);
});
