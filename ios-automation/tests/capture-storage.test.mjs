import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { evidencePaths, makeCapturePaths, reserveCapturePaths } from '../scripts/capture-storage.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photos-capture-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('captures are flat, retain the original name, and strip only photo extensions', () => {
  const planned = makeCapturePaths('/tmp/run', { originalFilename: '여행.IMG_1234.HEIC', index: 1 });
  assert.equal(planned.beforeCapture, '여행.IMG_1234-preview-capture.png');
  assert.equal(planned.afterCapture, '여행.IMG_1234-result-capture.png');
  assert.equal(planned.originalFilename, '여행.IMG_1234.HEIC');
  assert.equal(planned.generation, '.metadata/여행.IMG_1234-generation.json');
  assert.equal(makeCapturePaths('/tmp/run', { originalFilename: 'animation.gif', index: 1 }).outputBase, 'animation.gif');
});

test('missing names and paths are rejected instead of inventing photo names', () => {
  for (const originalFilename of [undefined, '', '   ', '../IMG_1.jpg', '/IMG_1.jpg', 'folder\\IMG_1.jpg', '..', 'a\0b.jpg', 'x\ny.jpg']) {
    assert.throws(() => makeCapturePaths('/tmp/run', { originalFilename, index: 1 }));
  }
  assert.throws(() => makeCapturePaths('/tmp/run', { originalFilename: 'IMG_1.jpg', index: 0 }));
  assert.throws(() => makeCapturePaths('/tmp/run', { originalFilename: 'IMG_1.jpg', index: 1, attempt: 0 }));
});

test('unsafe filename characters are sanitized without escaping the folder', () => {
  const paths = makeCapturePaths('/tmp/run', { originalFilename: '..trip:day?1.jpg', index: 1 });
  assert.equal(paths.outputBase, 'trip_day_1');
  assert.equal(path.dirname(paths.beforeCapture), '.');
  const long = makeCapturePaths('/tmp/run', { originalFilename: `${'사진'.repeat(100)}.jpg`, index: 1 });
  assert.ok(Buffer.byteLength(long.beforeCapture) < 255);
});

test('collisions account for both captures, metadata, case, and Unicode normalization', () => {
  for (const occupied of ['IMG_1-preview-capture.png', 'img_1-RESULT-capture.PNG', '.metadata/IMG_1-generation.json', 'img_1-RESULT.JPG']) {
    const paths = makeCapturePaths('/tmp/run', { originalFilename: 'IMG_1.JPG', index: 3, existingNames: [occupied] });
    assert.equal(paths.outputBase, 'IMG_1-photo-003');
  }
  const unicode = makeCapturePaths('/tmp/run', {
    originalFilename: 'Café.jpg', index: 3, existingNames: ['CAFE\u0301-preview-capture.png'],
  });
  assert.equal(unicode.outputBase, 'Café-photo-003');
});

test('retries and repeated collisions preserve earlier captures', () => {
  const planned = makeCapturePaths('/tmp/run', { originalFilename: 'IMG_1.jpg', index: 3, attempt: 2 });
  assert.equal(planned.outputBase, 'IMG_1-attempt-02');
  const collision = makeCapturePaths('/tmp/run', {
    originalFilename: 'IMG_1.jpg', index: 3,
    existingNames: ['IMG_1-preview-capture.png', 'IMG_1-photo-003-preview-capture.png', 'IMG_1-photo-003-attempt-02-preview-capture.png'],
  });
  assert.equal(collision.outputBase, 'IMG_1-photo-003-attempt-03');
});

test('reservation never replaces existing evidence and creates no per-photo folders', async (t) => {
  const runDir = await temporary(t);
  await writeFile(path.join(runDir, 'IMG_1-preview-capture.png'), 'keep this existing capture');
  const planned = await reserveCapturePaths(runDir, { originalFilename: 'IMG_1.JPG', index: 3 });
  assert.equal(planned.outputBase, 'IMG_1-photo-003');
  assert.equal(await readFile(path.join(runDir, 'IMG_1-preview-capture.png'), 'utf8'), 'keep this existing capture');
  assert.deepEqual((await readdir(runDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name), ['.metadata']);
  await writeFile(path.join(runDir, planned.beforeCapture), 'new capture');
  assert.equal(await readFile(path.join(runDir, planned.beforeCapture), 'utf8'), 'new capture');
});

test('concurrent case-equivalent reservations get distinct output names', async (t) => {
  const runDir = await temporary(t);
  const results = await Promise.all([
    reserveCapturePaths(runDir, { originalFilename: 'IMG_1.jpg', index: 1 }),
    reserveCapturePaths(runDir, { originalFilename: 'img_1.jpg', index: 2 }),
  ]);
  assert.notEqual(results[0].outputBase.toLowerCase(), results[1].outputBase.toLowerCase());
});

test('evidence resolves new and legacy manifests, including prior attempts', () => {
  const runDir = '/tmp/nonexistent-photos-run';
  const planned = makeCapturePaths(runDir, { originalFilename: 'IMG_1.jpg', index: 1 });
  assert.equal(evidencePaths(runDir, planned).beforeCapture, path.join(runDir, planned.beforeCapture));
  const legacy = evidencePaths(runDir, { before: 'photo-003/attempt-02/before-generation', after: 'photo-003/attempt-02/after-generation' });
  assert.equal(legacy.beforeCapture, path.join(runDir, 'photo-003/attempt-02/before-generation/screen.png'));
  assert.equal(legacy.generation, path.join(runDir, 'photo-003/attempt-02/generation.json'));
});

test('legacy and flat path escapes or incomplete flat records are rejected', () => {
  const runDir = '/tmp/run';
  for (const before of ['../elsewhere', '/tmp/elsewhere', 'photo/../../elsewhere', 'C:\\elsewhere']) {
    assert.throws(() => evidencePaths(runDir, { before, after: 'photo/after-generation' }));
  }
  const planned = makeCapturePaths(runDir, { originalFilename: 'IMG_1.jpg', index: 1 });
  assert.throws(() => evidencePaths(runDir, { ...planned, generation: '../generation.json' }));
  assert.throws(() => evidencePaths(runDir, { beforeCapture: planned.beforeCapture, before: 'photo/before', after: 'photo/after' }));
});

test('existing symlinks cannot redirect evidence outside the run', async (t) => {
  const runDir = await temporary(t);
  const outside = await temporary(t);
  await symlink(outside, path.join(runDir, '.metadata'));
  const planned = makeCapturePaths(runDir, { originalFilename: 'IMG_1.jpg', index: 1 });
  assert.throws(() => evidencePaths(runDir, planned), /symlink escapes/u);
  await assert.rejects(reserveCapturePaths(runDir, { originalFilename: 'IMG_1.jpg', index: 1 }), /real directory/u);
  assert.deepEqual(await readdir(outside), []);
});
