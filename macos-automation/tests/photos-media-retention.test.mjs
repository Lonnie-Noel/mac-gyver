import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('native retention verifies its JPEG and durably distinguishes retained results from unfinished or restored exports', { skip: process.platform !== 'darwin' }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'macgyver-retention-validation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const [implementation, fixture] = await Promise.all([
    readFile(path.join(root, 'native/PhotosMedia.swift'), 'utf8'),
    readFile(path.join(root, 'tests/native/PhotosMediaRetentionTests.swift'), 'utf8'),
  ]);
  const source = path.join(temp, 'PhotosMediaRetentionTests.swift');
  const executable = path.join(temp, 'photos-media-retention-tests');
  await writeFile(source, `${implementation}\n${fixture}`, { mode: 0o600 });
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await execute('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
    '-target', `${architecture}-apple-macosx15.2`, source, '-o', executable], { timeout: 120000 });
  const { stdout } = await execute(executable, [temp], { timeout: 15000 });
  assert.match(stdout, /PhotosMedia retention checks passed/);
  assert.match(stdout, /legacy ledger decoding, verified JPEG, durable terminal state/);
  assert.match(stdout, /idempotent retention, revert rejection/);
  assert.match(stdout, /changed hash\/file\/dimensions rejection/);
  assert.match(stdout, /no PhotoKit calls/);
});
