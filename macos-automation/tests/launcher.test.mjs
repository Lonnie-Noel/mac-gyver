import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macgyver-launcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'fixture-home');
  const bin = path.join(root, 'fixture-bin');
  await Promise.all([mkdir(scripts), mkdir(home), mkdir(bin)]);
  const helper = path.join(scripts, 'node-runtime.zsh');
  await copyFile(path.join(sourceRoot, 'scripts/node-runtime.zsh'), helper);
  // Fake Node recognizes this path without executing JavaScript or Photos code.
  await writeFile(path.join(scripts, 'runtime.mjs'), '// Runtime validation fixture.\n');
  const log = path.join(root, 'node-calls.bin');
  const env = { ...process.env, HOME: home, PATH: bin, MACGYVER_LAUNCHER_LOG: log };
  delete env.MACGYVER_NODE;
  delete env.MACGYVER_SELECTED_NODE;

  async function fakeNode(filename, { version = '26.9.0', supported = true, label = version } = {}) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `#!/bin/zsh
set -eu
printf '%s\\0' ${quote(label)} "$#" "$@" "$PATH" >> "$MACGYVER_LAUNCHER_LOG"
if [[ "\${1:-}" == --version ]]; then
  print -r -- ${quote(`v${version}`)}
elif [[ "\${1:t}" == runtime.mjs ]]; then
  ${supported ? 'exit 0' : "print -u2 -- 'Node.js 22.12.0 이상이 필요합니다.'; exit 1"}
fi
`, { mode: 0o755 });
    return filename;
  }
  async function calls() {
    if (!existsSync(log)) return [];
    const fields = (await readFile(log, 'utf8')).split('\0');
    assert.equal(fields.pop(), '');
    const entries = [];
    for (let i = 0; i < fields.length;) {
      const label = fields[i++];
      const count = Number(fields[i++]);
      assert.ok(Number.isSafeInteger(count) && count >= 0);
      const args = fields.slice(i, i + count); i += count;
      const actualPath = fields[i++];
      entries.push({ label, args, path: actualPath });
    }
    return entries;
  }
  function select(fallbacks = [''], changes = {}) {
    return spawnSync('/bin/zsh', ['-eu', '-c',
      'source "$1"; macgyver_select_node "$2" "\${@:3}"; print -r -- "$MACGYVER_SELECTED_NODE"',
      'launcher-test', helper, root, ...fallbacks], { env: { ...env, ...changes }, encoding: 'utf8' });
  }
  return { root, home, bin, env, helper, fakeNode, calls, select };
}

test('PATH Node 26 is selected before the legacy Node 22 fallback without changing PATH', async t => {
  const f = await fixture(t);
  const current = await f.fakeNode(path.join(f.bin, 'node'), { version: '26.9.0' });
  const legacy = await f.fakeNode(path.join(f.home, '.local/bin/node'), { version: '22.12.0' });
  const result = f.select([legacy]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), current);
  assert.match(result.stderr, /v26\.9\.0/);
  assert.ok(result.stderr.includes(current));
  assert.match(result.stderr, /현재 PATH/);
  const calls = await f.calls();
  assert.deepEqual(calls.map(call => call.label), ['26.9.0', '26.9.0']);
  assert.ok(calls.every(call => call.path === f.env.PATH));
  assert.equal(path.basename(calls[0].args[0]), 'runtime.mjs');
  assert.deepEqual(calls[1].args, ['--version']);
});

test('an absolute MACGYVER_NODE override wins over PATH and handles spaces in its executable path', async t => {
  const f = await fixture(t);
  await f.fakeNode(path.join(f.bin, 'node'), { label: 'path-node' });
  const override = await f.fakeNode(path.join(f.root, 'custom runtime', 'node'), { version: '24.5.0', label: 'override' });
  const result = f.select([''], { MACGYVER_NODE: override });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), override);
  assert.match(result.stderr, /v24\.5\.0.*MACGYVER_NODE/);
  assert.ok((await f.calls()).every(call => call.label === 'override' && call.path === f.env.PATH));
});

test('relative, nonexistent, nonexecutable, and empty explicit overrides fail without trying PATH', async t => {
  const f = await fixture(t);
  await f.fakeNode(path.join(f.bin, 'node'));
  const nonExecutable = path.join(f.root, 'nonexecutable-node');
  await writeFile(nonExecutable, 'not executable', { mode: 0o600 });
  for (const override of ['node', path.join(f.root, 'missing-node'), nonExecutable, '']) {
    const result = f.select([''], { MACGYVER_NODE: override });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MACGYVER_NODE.*절대 경로/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await f.calls(), []);
});

test('an unsupported explicit override fails rather than falling back to a supported PATH node', async t => {
  const f = await fixture(t);
  await f.fakeNode(path.join(f.bin, 'node'));
  const override = await f.fakeNode(path.join(f.root, 'old-node'), { version: '20.20.0', supported: false, label: 'override-old' });
  const result = f.select([''], { MACGYVER_NODE: override });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MACGYVER_NODE.*사용할 수 없습니다/);
  assert.match(result.stderr, /22\.12\.0 이상/);
  assert.deepEqual((await f.calls()).map(call => call.label), ['override-old']);
});

test('unsupported PATH node is skipped and a supported fallback is reported with its version and path', async t => {
  const f = await fixture(t);
  const current = await f.fakeNode(path.join(f.bin, 'node'), { version: '22.11.0', supported: false });
  const fallback = await f.fakeNode(path.join(f.root, 'fallback-bin/node'), { version: '22.12.0' });
  const result = f.select([current, fallback]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fallback);
  assert.match(result.stderr, /지원하지 않는 Node\.js/);
  assert.match(result.stderr, /v22\.12\.0.*대체 설치 경로/);
  assert.ok(result.stderr.includes(fallback));
  assert.deepEqual((await f.calls()).map(call => call.label), ['22.11.0', '22.12.0', '22.12.0']);
});

test('no compatible candidate fails clearly and does not invoke an unconfigured installed runtime', async t => {
  const f = await fixture(t);
  await f.fakeNode(path.join(f.bin, 'node'), { version: '20.0.0', supported: false });
  const result = f.select(['']); // Deliberately empty fixture fallback list.
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Node\.js 22\.12\.0 이상을 찾지 못했습니다/);
  assert.deepEqual((await f.calls()).map(call => call.label), ['20.0.0']);
});

test('an empty PATH fixture can select an explicitly supplied supported fallback', async t => {
  const f = await fixture(t);
  const fallback = await f.fakeNode(path.join(f.home, '.local/bin/node'), { version: '26.9.0' });
  const result = f.select([path.join(f.root, 'missing'), fallback]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fallback);
  assert.match(result.stderr, /대체 설치 경로/);
  assert.ok((await f.calls()).every(call => call.path === f.env.PATH));
});

test('all Finder launchers preserve their action and arguments and the one-photo launcher ends with --limit 1', async t => {
  for (const [filename, action, build, single] of [
    ['Mac 사진 자동화 설정.command', 'setup', false, false],
    ['Mac 사진 자동화 시작.command', 'run', false, false],
    ['Mac 사진 자동화 1장 테스트.command', 'run', false, true],
    ['Mac 사진 자동화 중지.command', 'stop', false, false],
    ['Mac 사진 자동화 복구.command', 'recover', false, false],
  ]) {
    await t.test(filename, async t => {
      const f = await fixture(t);
      await f.fakeNode(path.join(f.bin, 'node'), { label: 'path-26' });
      await f.fakeNode(path.join(f.home, '.local/bin/node'), { version: '22.12.0', label: 'legacy-22' });
      const launcher = path.join(f.root, filename);
      await copyFile(path.join(sourceRoot, filename), launcher);
      const args = ['--album-id', 'album with spaces', ...(single ? ['--limit', '99'] : [])];
      const result = spawnSync('/bin/zsh', [launcher, ...args], { env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const calls = await f.calls();
      assert.ok(calls.every(call => call.label === 'path-26' && call.path === f.env.PATH));
      const executions = calls.filter(call => ['scripts/build.mjs', 'scripts/run.mjs'].includes(call.args[0]));
      assert.deepEqual(executions.map(call => call.args), [
        ...(build ? [['scripts/build.mjs']] : []),
        ['scripts/run.mjs', action, ...args, ...(single ? ['--limit', '1'] : [])],
      ]);
    });
  }
});
