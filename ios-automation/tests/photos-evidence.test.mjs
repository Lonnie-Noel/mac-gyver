import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { validateCompleted } from '../scripts/photos-batch.mjs';
import { evidencePaths, reserveCapturePaths } from '../scripts/capture-storage.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MlQAAAAASUVORK5CYII=', 'base64');
const PREVIEW_XML = `<XCUIElementTypeApplication>
  <XCUIElementTypeOther name="spatialReframeMediaView" visible="true" />
  <XCUIElementTypeButton name="프레임 재설정" visible="true" enabled="true" />
</XCUIElementTypeApplication>`;
const RESULT_XML = `<XCUIElementTypeApplication>
  <XCUIElementTypeOther name="spatialReframeMediaView" visible="true" />
  <XCUIElementTypeStaticText name="editAIStatusViewCompleted" visible="true" />
  <XCUIElementTypeButton name="Save" visible="true" enabled="true" />
</XCUIElementTypeApplication>`;
const WRONG_XML = '<XCUIElementTypeApplication><XCUIElementTypeNavigationBar name="PUOneUpView" visible="true" /></XCUIElementTypeApplication>';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const GENERATION = {
  startedAt: new Date(START).toISOString(),
  minimumWaitSeconds: 25,
  drag: { from: [201, 437], to: [5, 633], durationMs: 1500 },
};

async function fixture(t, legacy = false) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'photos-evidence-test-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const entry = {
    status: 'complete', index: 3, attempt: 1, returnedToViewer: true,
    ...(legacy
      ? { before: 'photo-003/before-generation', after: 'photo-003/after-generation' }
      : await reserveCapturePaths(runDir, { originalFilename: 'IMG_0123.HEIC', index: 3 })),
  };
  const files = evidencePaths(runDir, entry);
  for (const file of Object.values(files)) await mkdir(path.dirname(file), { recursive: true });
  await writeFile(files.beforeCapture, PNG);
  await writeFile(files.afterCapture, PNG);
  await writeFile(files.beforeSource, PREVIEW_XML);
  await writeFile(files.afterSource, RESULT_XML);
  await writeFile(files.generation, JSON.stringify(GENERATION));
  await utimes(files.afterCapture, (START + 30_000) / 1000, (START + 30_000) / 1000);
  return { runDir, entry, files };
}

// Invalid evidence may be reported as false or an explicit validation error.
// Neither outcome may allow a completed photo to be skipped during resume.
async function assertRejected(runDir, entry) {
  let accepted = false;
  try { accepted = await validateCompleted(runDir, entry); } catch { /* rejected */ }
  assert.notEqual(accepted, true);
}

test('flat evidence validates completed generation and original-viewer return', async (t) => {
  const { runDir, entry } = await fixture(t);
  assert.equal(await validateCompleted(runDir, entry), true);
  assert.equal(path.dirname(entry.beforeCapture), '.');
  assert.equal(path.dirname(entry.afterCapture), '.');
});

test('legacy photo directories remain valid with inferred generation metadata', async (t) => {
  const { runDir, entry } = await fixture(t, true);
  assert.equal(await validateCompleted(runDir, entry), true);
});

test('captures alone do not complete an unfinished or unreturned photo', async (t) => {
  const { runDir, entry } = await fixture(t);
  assert.equal(await validateCompleted(runDir, { ...entry, status: 'running' }), false);
  assert.equal(await validateCompleted(runDir, { ...entry, returnedToViewer: false }), false);
  assert.equal(await validateCompleted(runDir, { ...entry, returnedToViewer: undefined }), false);
});

test('missing output, XML, or generation metadata is rejected', async (t) => {
  for (const field of ['beforeCapture', 'afterCapture', 'beforeSource', 'afterSource', 'generation']) {
    const { runDir, entry, files } = await fixture(t);
    await unlink(files[field]);
    await assertRejected(runDir, entry);
  }
});

test('non-PNG and empty capture files are rejected', async (t) => {
  for (const contents of [Buffer.alloc(0), Buffer.from('not a screenshot')]) {
    const { runDir, entry, files } = await fixture(t);
    await writeFile(files.afterCapture, contents);
    await assertRejected(runDir, entry);
  }
});

test('both the dragged preview and completed result UI must be present', async (t) => {
  for (const field of ['beforeSource', 'afterSource']) {
    const { runDir, entry, files } = await fixture(t);
    await writeFile(files[field], WRONG_XML);
    await assertRejected(runDir, entry);
  }
  const { runDir, entry, files } = await fixture(t);
  await writeFile(files.afterSource, RESULT_XML.replace('</XCUIElementTypeApplication>', '<XCUIElementTypeActivityIndicator visible="true" /></XCUIElementTypeApplication>'));
  await assertRejected(runDir, entry);
});

test('result captured before 25 seconds cannot be completed', async (t) => {
  const { runDir, entry, files } = await fixture(t);
  await utimes(files.afterCapture, (START + 24_000) / 1000, (START + 24_000) / 1000);
  await assertRejected(runDir, entry);
});

test('generation metadata must document the required wait and gesture', async (t) => {
  for (const generation of [
    { ...GENERATION, minimumWaitSeconds: 24 },
    { ...GENERATION, startedAt: 'unknown' },
    { ...GENERATION, drag: { ...GENERATION.drag, to: [5, 632] } },
  ]) {
    const { runDir, entry, files } = await fixture(t);
    await writeFile(files.generation, JSON.stringify(generation));
    await assertRejected(runDir, entry);
  }
});

test('flat and legacy manifest paths cannot escape their run directory', async (t) => {
  const flat = await fixture(t);
  await assertRejected(flat.runDir, { ...flat.entry, afterCapture: '../result.png' });
  await assertRejected(flat.runDir, { ...flat.entry, generation: '/tmp/outside-generation.json' });
  const legacy = await fixture(t, true);
  await assertRejected(legacy.runDir, { ...legacy.entry, before: '../before-generation' });
});
