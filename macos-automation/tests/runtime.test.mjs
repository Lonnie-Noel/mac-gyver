import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { supportsNodeVersion, requireNodeVersion, minimumNodeVersion } from '../scripts/runtime.mjs';

test('runtime accepts the minimum, existing 22 installations, and newer stable versions including 26.9', () => {
  for (const version of ['22.12.0', '22.22.3', '22.23.1', '24.0.0', '26.9.0', 'v26.9.0', '28.0.0']) {
    assert.equal(supportsNodeVersion(version), true, version);
    assert.doesNotThrow(() => requireNodeVersion(version));
  }
});

test('old, malformed, and prerelease runtimes fail before running the workflow', () => {
  for (const version of ['20.19.0', '22.11.9', '', '26.9', '26.9.0-nightly', 'node26.9.0']) {
    assert.equal(supportsNodeVersion(version), false, version);
    assert.throws(() => requireNodeVersion(version), /22\.12\.0 이상/);
  }
});

test('package engine range and shared runtime minimum agree without an upper cap', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, `>=${minimumNodeVersion}`);
});
