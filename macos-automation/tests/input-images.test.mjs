import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, realpath, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanInputImages, importInputImages, requireFileImportSupport, requireImportReady, verifyImportedAlbum, waitForImportedAlbum } from '../scripts/input-images.mjs';
import { selectors } from '../scripts/core.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
const RUN_ID = 'test-run-001';
const ALBUM_NAME = 'MacGyver 입력 테스트';
const ALBUM = Object.freeze({ id: 'test-album', name: ALBUM_NAME });

test('input import requires a helper with bulk import support before importing more copies', () => {
  for (const status of [undefined, {}, { capabilities: ['input-images-v1'] }, { capabilities: ['input-images-file-resource-v1'] }, { capabilities: 'input-images-batch-v1' }]) {
    assert.throws(() => requireFileImportSupport(status), /새 도우미/);
  }
  assert.doesNotThrow(() => requireFileImportSupport({ capabilities: ['input-images-v1', 'input-images-batch-v1'] }));
});

async function inputDirectory(t, entries = { 'first.jpg': 'synthetic image bytes' }) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'macgyver-input-images-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) await writeFile(path.join(directory, name), content);
  return directory;
}

function importer(options = {}) {
  const calls = [], journal = [];
  const bridge = {
    async call(action, args) {
      assert.equal(action, 'importImages', 'input files must be imported in one native transaction');
      calls.push({ action, args: structuredClone(args) });
      const response = {
        album: { ...ALBUM },
        imports: args.files.map((source, index) => ({
          item: { id: `test-asset-${index + 1}`, filename: source.filename, width: 640, height: 480 },
          sourceSHA256: source.sha256,
        })),
      };
      return options.respond ? options.respond(response) : response;
    },
  };
  const configuration = {
    runID: RUN_ID, albumName: ALBUM_NAME, stopped: () => false,
    onImported: async record => { journal.push(structuredClone(record)); },
    ...options.configuration,
  };
  return { bridge, configuration, calls, journal };
}

test('input scan accepts supported image extensions case-insensitively in deterministic filename order', async t => {
  const entries = {
    'z.TIFF': 'tiff', 'B.JPEG': 'jpeg', 'a.png': 'png',
    'C.heic': 'heic', 'd.HEIF': 'heif', 'E.tif': 'tif', 'f.JPG': 'jpg',
  };
  const directory = await inputDirectory(t, entries);
  const result = await scanInputImages(path.join(directory, '.'));
  assert.equal(result.directory, path.resolve(directory));
  assert.deepEqual(result.files.map(file => file.filename), Object.keys(entries).sort());
  assert.deepEqual(result.ignored, []);
  for (const file of result.files) {
    assert.equal(file.path, path.join(directory, file.filename));
    assert.equal(file.bytes, Buffer.byteLength(entries[file.filename]));
    assert.equal(file.sha256, sha256(Buffer.from(entries[file.filename])));
  }
});

test('input scan is top-level only and ignores hidden files, README, markers, and unsupported formats', async t => {
  const directory = await inputDirectory(t, {
    'photo.JPG': 'image', '.hidden.jpg': 'hidden', 'README.md': 'instructions',
    '.gitkeep': '', 'notes.txt': 'notes', 'movie.mov': 'video',
  });
  await mkdir(path.join(directory, 'nested'));
  await writeFile(path.join(directory, 'nested', 'second.jpg'), 'nested image');
  const result = await scanInputImages(directory);
  assert.deepEqual(result.files.map(file => file.filename), ['photo.JPG']);
  assert.deepEqual([...result.ignored].sort(), ['.gitkeep', '.hidden.jpg', 'README.md', 'movie.mov', 'nested', 'notes.txt'].sort());
});

test('scan always inventories every image even when the caller has a processing limit', async t => {
  const directory = await inputDirectory(t, { 'z.jpg': 'z', 'b.png': 'b', 'a.jpeg': 'a' });
  const result = await scanInputImages(directory, { limit: 1 });
  assert.deepEqual(result.files.map(file => file.filename), ['a.jpeg', 'b.png', 'z.jpg']);
});

test('supported image symlinks and empty files are rejected, including entries beyond the limit', async t => {
  const directory = await inputDirectory(t, { 'a.jpg': 'image' });
  const link = path.join(directory, 'z.jpeg');
  await symlink(path.join(directory, 'a.jpg'), link);
  await assert.rejects(() => scanInputImages(directory, { limit: 1 }), Error);
  await rm(link);
  await writeFile(path.join(directory, 'z.png'), Buffer.alloc(0));
  await assert.rejects(() => scanInputImages(directory, { limit: 1 }), Error);
});

test('missing paths, regular files, and symlinked directories cannot be input directories', async t => {
  const directory = await inputDirectory(t);
  const link = path.join(directory, 'linked-directory');
  await symlink(directory, link);
  for (const candidate of [path.join(directory, 'missing'), path.join(directory, 'first.jpg'), link]) {
    await assert.rejects(() => scanInputImages(candidate), Error, candidate);
  }
});

test('empty directories and directories containing only unsupported or hidden files are rejected', async t => {
  for (const entries of [{}, { 'README.md': 'instructions', '.gitkeep': '', '.hidden.png': 'hidden', 'movie.mp4': 'video' }]) {
    const directory = await inputDirectory(t, entries);
    await assert.rejects(() => scanInputImages(directory), Error);
  }
});

test('scan and one bulk import preserve bytes and send all exact file identities together', async t => {
  const entries = { 'two.PNG': Buffer.from([1, 2, 3]), 'one.JPG': Buffer.from([4, 5, 6, 7]) };
  const directory = await inputDirectory(t, entries), { files } = await scanInputImages(directory);
  const f = importer(), result = await importInputImages(f.bridge, files, f.configuration);
  assert.deepEqual(result.album, ALBUM);
  assert.equal(result.source, 'input-folder');
  assert.deepEqual(result.items.map(item => item.id), ['test-asset-1', 'test-asset-2']);
  assert.deepEqual(f.calls, [{ action: 'importImages', args: { runID: RUN_ID, albumName: ALBUM_NAME, files } }]);
  for (let index = 0; index < files.length; index++) {
    assert.deepEqual(f.journal[index], { source: files[index], album: ALBUM, item: result.items[index] });
    assert.deepEqual(await readFile(files[index].path), entries[files[index].filename]);
  }
});

test('a malformed LAST import rejects the entire response before journaling any item', async t => {
  const { files } = await scanInputImages(await inputDirectory(t, { 'a.jpg': 'a', 'b.jpg': 'b' }));
  for (const change of [
    entry => ({ ...entry, sourceSHA256: 'f'.repeat(64) }),
    entry => ({ ...entry, item: { ...entry.item, filename: 'wrong.jpg' } }),
    ...[{ id: '' }, { id: null }, { id: 'test-asset-1' }, { width: 0 }, { height: -1 }, { width: 1.5 }, { height: Infinity }]
      .map(properties => entry => ({ ...entry, item: { ...entry.item, ...properties } })),
  ]) {
    const f = importer({ respond: response => ({ ...response, imports: [response.imports[0], change(response.imports[1])] }) });
    await assert.rejects(() => importInputImages(f.bridge, files, f.configuration), Error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.journal.length, 0);
  }
});

test('bulk import requires the requested album and exact ordered response count', async t => {
  const { files } = await scanInputImages(await inputDirectory(t, { 'a.jpg': 'a', 'b.jpg': 'b' }));
  for (const change of [
    response => ({ ...response, album: undefined }),
    response => ({ ...response, album: { id: '', name: ALBUM_NAME } }),
    response => ({ ...response, album: { id: 'album', name: 'different name' } }),
    response => ({ ...response, imports: response.imports.slice(0, 1) }),
    response => ({ ...response, imports: [...response.imports, response.imports[0]] }),
    response => ({ ...response, imports: response.imports.toReversed() }),
  ]) {
    const f = importer({ respond: change });
    await assert.rejects(() => importInputImages(f.bridge, files, f.configuration), Error);
    assert.equal(f.journal.length, 0);
  }
});

test('all validated import receipts are awaited in input order with no second native request', async t => {
  const { files } = await scanInputImages(await inputDirectory(t, { 'a.jpg': 'a', 'b.jpg': 'b' }));
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { announce = resolve; });
  const events = [];
  const f = importer({ configuration: { async onImported(record) {
    events.push(`start-${record.item.id}`);
    if (record.item.id === 'test-asset-1') { announce(); await gate; }
    events.push(`end-${record.item.id}`);
  } } });
  const pending = importInputImages(f.bridge, files, f.configuration);
  await started;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(events, ['start-test-asset-1']);
  release();
  await pending;
  assert.deepEqual(events, ['start-test-asset-1', 'end-test-asset-1', 'start-test-asset-2', 'end-test-asset-2']);
});

test('receipt write failure is propagated without resending the completed transaction', async t => {
  const { files } = await scanInputImages(await inputDirectory(t, { 'a.jpg': 'a', 'b.jpg': 'b' }));
  const f = importer({ configuration: { onImported: async () => { throw new Error('journal storage unavailable'); } } });
  await assert.rejects(() => importInputImages(f.bridge, files, f.configuration), /journal storage unavailable/);
  assert.equal(f.calls.length, 1);
});

test('stop before dispatch prevents import; stop during import still journals ALL successful receipts', async t => {
  const { files } = await scanInputImages(await inputDirectory(t, { 'a.jpg': 'a', 'b.jpg': 'b' }));
  const before = importer({ configuration: { stopped: () => true } });
  await assert.rejects(() => importInputImages(before.bridge, files, before.configuration), Error);
  assert.equal(before.calls.length, 0);
  let stopped = false;
  const f = importer({ respond: response => { stopped = true; return response; }, configuration: { stopped: () => stopped } });
  const result = await importInputImages(f.bridge, files, f.configuration);
  assert.equal(result.items.length, 2);
  assert.equal(f.journal.length, 2);
  assert.equal(f.calls.length, 1);
});

test('oversized import requests stop before dispatch rather than timing out in native IPC', async () => {
  const f = importer();
  const files = [{ path: 'x'.repeat(901_000), filename: 'a.jpg', bytes: 1, sha256: 'a'.repeat(64) }];
  await assert.rejects(() => importInputImages(f.bridge, files, f.configuration), /요청이 너무 큽니다/);
  assert.equal(f.calls.length, 0);
});

function readyBridge(nodes = []) {
  const calls = [];
  const bridge = {
    async call(action) {
      calls.push(action);
      assert.ok(['activate', 'snapshot'].includes(action), `Readiness must not perform ${action}`);
      if (action === 'activate') return {};
      return {
        nodes, frontmost: true, appPid: 123, truncated: false,
        window: { title: '사진', rect: { x: 100, y: 50, width: 1200, height: 900 } },
      };
    },
  };
  return { bridge, calls };
}

test('import readiness accepts the Photos grid or viewer without selecting or importing any photo', async () => {
  for (const nodes of [[], [{ ...selectors.edit, enabled: true }]]) {
    const f = readyBridge(nodes);
    await requireImportReady(f.bridge);
    assert.deepEqual(f.calls, ['activate', 'snapshot']);
  }
});

test('import readiness refuses editor controls even when disabled, modals, alerts, and busy states', async () => {
  for (const nodes of [
    [{ ...selectors.done, enabled: true }],
    [{ ...selectors.done, enabled: false }],
    [{ ...selectors.cancel, enabled: false }, { ...selectors.save, enabled: false }],
    [{ role: 'AXSheet', enabled: true }],
    [{ role: 'AXWindow', subrole: 'AXDialog', enabled: true }],
    [{ role: 'AXProgressIndicator', enabled: false }],
    [{ role: 'AXStaticText', value: '생성 중', enabled: true }],
  ]) {
    const f = readyBridge(nodes);
    await assert.rejects(() => requireImportReady(f.bridge), Error);
    assert.deepEqual(f.calls, ['activate', 'snapshot']);
  }
});

test('imported album verification accepts the exact asset set and preserves actual Photos ordering', () => {
  const items = [{ id: 'asset-one' }, { id: 'asset-two' }, { id: 'asset-three' }];
  const contents = { id: ALBUM.id, items: [items[2], items[0], items[1]] };
  assert.deepEqual(verifyImportedAlbum(contents, ALBUM, items), ['asset-three', 'asset-one', 'asset-two']);
  assert.deepEqual(items.map(item => item.id), ['asset-one', 'asset-two', 'asset-three']);
});

test('imported album verification rejects extra, missing, duplicated, foreign assets and another album', () => {
  const items = [{ id: 'asset-one' }, { id: 'asset-two' }, { id: 'asset-three' }];
  for (const contents of [
    { id: ALBUM.id, items: [...items, { id: 'extra-asset' }] },
    { id: ALBUM.id, items: items.slice(0, 2) },
    { id: ALBUM.id, items: [items[0], items[1], items[1]] },
    { id: ALBUM.id, items: [items[0], items[1], { id: 'foreign-asset' }] },
    { id: 'foreign-album', items },
    { id: ALBUM.id },
  ]) assert.throws(() => verifyImportedAlbum(contents, ALBUM, items), Error);
});

test('default CLI plan hashes InputImages without config, a helper, or any access outside its temporary project', async t => {
  const directory = await inputDirectory(t, {});
  const scripts = path.join(directory, 'scripts');
  const inputs = path.join(directory, 'InputImages');
  await mkdir(scripts);
  await mkdir(inputs);
  for (const filename of ['run.mjs', 'bridge.mjs', 'core.mjs', 'workflow.mjs', 'runtime.mjs', 'setup.mjs', 'input-images.mjs', 'batch-state.mjs']) {
    await copyFile(new URL(`../scripts/${filename}`, import.meta.url), path.join(scripts, filename));
  }
  // Deliberately not a decodable JPEG: offline planning only inventories bytes.
  const bytes = Buffer.from('arbitrary synthetic fake.jpg bytes');
  await writeFile(path.join(inputs, 'fake.jpg'), bytes);
  await writeFile(path.join(inputs, 'README.md'), 'not an image');
  const { stdout } = await execute(process.execPath, [
    '--experimental-permission',
    `--allow-fs-read=${directory}`,
    `--allow-fs-write=${directory}`,
    path.join(scripts, 'run.mjs'), 'plan',
  ], {
    cwd: directory, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  // Child processes are denied and outside paths (including the real private
  // helper directory and Photos library) are inaccessible in this subprocess.
  assert.match(stdout, /fake\.jpg/);
  assert.deepEqual((await readdir(directory)).sort(), ['InputImages', 'artifacts', 'scripts']);
  const artifacts = path.join(directory, 'artifacts');
  const names = await readdir(artifacts);
  assert.equal(names.length, 1);
  assert.match(names[0], /^plan-\d+\.json$/);
  const plan = JSON.parse(await readFile(path.join(artifacts, names[0]), 'utf8'));
  assert.equal(plan.source, 'input-folder');
  assert.equal(plan.directory, inputs);
  assert.deepEqual(plan.files, [{ path: path.join(inputs, 'fake.jpg'), filename: 'fake.jpg', bytes: bytes.length, sha256: sha256(bytes) }]);
  assert.deepEqual(plan.ignored, ['README.md']);
  assert.deepEqual(await readFile(path.join(inputs, 'fake.jpg')), bytes);
});

function albumVisibility(responses, { onSleep } = {}) {
  const calls = [], sleeps = [];
  let clock = 1_000;
  const bridge = {
    async call(action, args) {
      assert.equal(action, 'albumItems', 'album visibility polling must only read, never import again');
      assert.deepEqual(args, { id: ALBUM.id });
      calls.push({ action, args });
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
  const options = {
    timeoutMs: 1_000, pollIntervalMs: 250,
    now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; onSleep?.(); },
  };
  return { bridge, options, calls, sleeps };
}

test('album visibility waits through an absent album and incomplete membership before accepting the exact unordered set', async () => {
  const items = [{ id: 'asset-one' }, { id: 'asset-two' }];
  const f = albumVisibility([
    new Error('요청한 앨범 ID를 찾을 수 없습니다'),
    { id: ALBUM.id, items: [items[0]] },
    { id: ALBUM.id, items: [items[1], items[0]] },
  ]);
  const actualOrder = await waitForImportedAlbum(f.bridge, ALBUM, items, f.options);
  assert.deepEqual(actualOrder, ['asset-two', 'asset-one']);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.sleeps, [250, 250]);
});

test('album membership timeout performs bounded reads without retrying any import', async () => {
  const items = [{ id: 'asset-one' }, { id: 'asset-two' }];
  const f = albumVisibility([{ id: ALBUM.id, items: [items[0]] }]);
  await assert.rejects(() => waitForImportedAlbum(f.bridge, ALBUM, items, f.options), /초과/);
  const elapsed = f.options.now() - 1_000;
  assert.ok(elapsed >= f.options.timeoutMs);
  assert.ok(elapsed <= f.options.timeoutMs + f.options.pollIntervalMs);
  assert.ok(f.calls.length > 1 && f.calls.length <= 6);
  assert.ok(f.calls.every(call => call.action === 'albumItems'));
});

test('an unexpected album permission error is propagated immediately without polling', async () => {
  const permissionError = new Error('Apple Events permission denied (-1743)');
  const f = albumVisibility([permissionError]);
  await assert.rejects(() => waitForImportedAlbum(f.bridge, ALBUM, [{ id: 'asset-one' }], f.options), error => error === permissionError);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sleeps, []);
});

test('stop between album visibility attempts prevents a subsequent read', async () => {
  let stopped = false;
  const f = albumVisibility([{ id: ALBUM.id, items: [] }], { onSleep: () => { stopped = true; } });
  await assert.rejects(() => waitForImportedAlbum(f.bridge, ALBUM, [{ id: 'asset-one' }], {
    ...f.options, stopped: () => stopped,
  }), /중지/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sleeps, [250]);
});
