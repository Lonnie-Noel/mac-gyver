import test from 'node:test';
import assert from 'node:assert/strict';
import { openSettings } from '../scripts/setup.mjs';

function fixture({ running = false, pending = false, app = true, buildError, showError } = {}) {
  const calls = [];
  return { calls, options: {
    isRunning: async () => running,
    hasPending: () => pending,
    hasApp: () => app,
    build: async () => { calls.push('build'); if (buildError) throw buildError; },
    show: async () => { calls.push('show'); if (showError) throw showError; },
    log: () => {},
  } };
}

test('running hidden helper is reopened without attempting a build', async () => {
  const { calls, options } = fixture({ running: true, buildError: new Error('must not build') });
  assert.equal(await openSettings(options), 'reopened');
  assert.deepEqual(calls, ['show']);
});

test('stopped helper is built before displaying settings', async () => {
  const { calls, options } = fixture();
  assert.equal(await openSettings(options), 'ready');
  assert.deepEqual(calls, ['build', 'show']);
});

test('pending edit opens existing helper for recovery without rebuilding', async () => {
  const { calls, options } = fixture({ pending: true });
  assert.equal(await openSettings(options), 'recovery');
  assert.deepEqual(calls, ['show']);
});

test('pending edit with missing helper cannot trigger a replacement build', async () => {
  const { calls, options } = fixture({ pending: true, app: false });
  await assert.rejects(openSettings(options), /미완료 편집 기록/);
  assert.deepEqual(calls, []);
});

test('real compiler failure is reported without launching the old helper', async () => {
  const { calls, options } = fixture({ buildError: new Error('compiler failed') });
  await assert.rejects(openSettings(options), /compiler failed/);
  assert.deepEqual(calls, ['build']);
});

test('unresponsive running helper is not replaced or forcibly terminated', async () => {
  const { calls, options } = fixture({ running: true, showError: new Error('request timed out') });
  await assert.rejects(openSettings(options), /request timed out/);
  assert.deepEqual(calls, ['show']);
});
