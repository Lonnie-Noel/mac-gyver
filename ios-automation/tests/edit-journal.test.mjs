import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginPendingEdit, finishPendingEdit, readPendingEdit, recoverPendingEdit, updatePendingEdit } from '../scripts/edit-journal.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photos-edit-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'pending.json');
  const baseline = { assetId: 'asset-one', originalFilename: 'IMG_1234.HEIC', originalSHA256: 'a'.repeat(64),
    currentSHA256: 'b'.repeat(64), hasAdjustments: false,
    selection: { creationLocal: { year: 2024, month: 2, day: 29, hour: 13, minute: 45 }, width: 4032, height: 3024 } };
  const params = { runDir: directory, index: 2, total: 25, baseline,
    entry: { outputBase: 'IMG_1234', originalFilename: 'IMG_1234.HEIC' }, bundleId: 'com.example.PhotosExportBridge' };
  const pending = await beginPendingEdit(params, filename);
  return { directory, filename, baseline, params, pending };
}

test('journal starts before saving and another run cannot replace it', async (t) => {
  const f = await fixture(t);
  assert.equal((await readPendingEdit(f.filename)).phase, 'saving');
  await assert.rejects(beginPendingEdit(f.params, f.filename), { code: 'EEXIST' });
  await assert.rejects(updatePendingEdit({ ...f.pending, id: 'other-owner' }, { phase: 'saved' }, f.filename));
  await assert.rejects(finishPendingEdit({ ...f.pending, id: 'other-owner' }, f.filename));
  assert.equal((await readPendingEdit(f.filename)).id, f.pending.id);
});

test('existing edits cannot begin an automatic save/revert transaction', async (t) => {
  const f = await fixture(t);
  await finishPendingEdit(f.pending, f.filename);
  await assert.rejects(beginPendingEdit({ ...f.params, baseline: { ...f.baseline, hasAdjustments: true } }, f.filename));
  assert.equal(await readPendingEdit(f.filename), null);
});

function adapter(f, current, events, receipt = { sha256: 'c'.repeat(64) }) {
  return {
    inspect: async (name, options) => { events.push('inspect'); assert.equal(name, f.baseline.originalFilename);
      assert.deepEqual(options, { preserveBaseline: true, assetId: f.baseline.assetId,
        baselineOriginalSHA256: f.baseline.originalSHA256 }); return current; },
    findVerifiedExport: async () => { events.push('find'); return null; },
    exportResult: async () => { events.push('export'); return receipt; },
    verifyLocalExport: async () => { events.push('verify'); return receipt; },
    revert: async () => { events.push('revert'); return { restored: true }; },
  };
}

test('recovery exports and verifies before restoring a saved edit', async (t) => {
  const f = await fixture(t);
  const events = [];
  const bridge = adapter(f, { ...f.baseline, hasAdjustments: true }, events);
  const result = await recoverPendingEdit({ pending: f.pending, filename: f.filename, bridge,
    verifyViewer: async () => events.push('viewer'), persist: async (pending, receipt) => {
      events.push('persist'); assert.equal(pending.phase, 'restored'); assert(receipt);
    } });
  assert.deepEqual(events, ['viewer', 'inspect', 'find', 'export', 'verify', 'revert', 'viewer', 'persist']);
  assert.equal(result.resultSaved, true);
  assert.equal(await readPendingEdit(f.filename), null);
});

test('same-name recovery uses exact recorded asset identity without stale original dimensions', async (t) => {
  const f = await fixture(t);
  const events = [];
  const edited = { ...f.baseline, hasAdjustments: true,
    selection: { ...f.baseline.selection, width: 5000, height: 4000 } };
  const bridge = adapter(f, edited, events);
  let optionsSeen;
  const inspect = bridge.inspect;
  bridge.inspect = async (name, options) => { optionsSeen = options; return inspect(name, options); };
  await recoverPendingEdit({ pending: f.pending, filename: f.filename, bridge,
    verifyViewer: async () => {}, persist: async () => {} });
  assert.equal(optionsSeen.assetId, 'asset-one');
  assert.equal(optionsSeen.baselineOriginalSHA256, f.baseline.originalSHA256);
  assert.equal(Object.hasOwn(optionsSeen, 'selection'), false);
  assert(events.includes('export'));
  assert(events.includes('revert'));
  assert.equal(await readPendingEdit(f.filename), null);
});

test('an unsaved or cancelled draft is recovered without inventing an exported result', async (t) => {
  const f = await fixture(t);
  const events = [];
  const result = await recoverPendingEdit({ pending: f.pending, filename: f.filename,
    bridge: adapter(f, f.baseline, events), verifyViewer: async () => {}, persist: async (_, receipt) => assert.equal(receipt, null) });
  assert.equal(result.resultSaved, false);
  assert.deepEqual(events, ['inspect', 'find']);
});

test('recovery completes helper verification when revert finished before its response', async (t) => {
  const f = await fixture(t);
  const receipt = { sha256: 'c'.repeat(64) };
  const pending = await updatePendingEdit(f.pending, { phase: 'exported', exportReceipt: receipt }, f.filename);
  const events = [];
  await recoverPendingEdit({ pending, filename: f.filename, bridge: adapter(f, f.baseline, events),
    verifyViewer: async () => {}, persist: async () => {} });
  assert.deepEqual(events, ['inspect', 'verify', 'revert']);
});

test('failed file validation leaves the pending edit and never restores', async (t) => {
  const f = await fixture(t);
  const events = [];
  const bridge = adapter(f, { ...f.baseline, hasAdjustments: true }, events);
  bridge.verifyLocalExport = async () => { throw new Error('JPEG hash mismatch'); };
  await assert.rejects(recoverPendingEdit({ pending: f.pending, filename: f.filename, bridge,
    verifyViewer: async () => {}, persist: async () => assert.fail('must not persist completion') }), /hash mismatch/);
  assert(!events.includes('revert'));
  assert(await readPendingEdit(f.filename));
});

test('a changed asset or original blocks recovery before export or revert', async (t) => {
  const f = await fixture(t);
  const events = [];
  const bridge = adapter(f, { ...f.baseline, assetId: 'another-asset', hasAdjustments: true }, events);
  await assert.rejects(recoverPendingEdit({ pending: f.pending, filename: f.filename, bridge,
    verifyViewer: async () => {}, persist: async () => {} }), /identity/);
  assert.deepEqual(events, ['inspect']);
  assert(await readPendingEdit(f.filename));
});

test('stop after export preserves the pending journal and sends no revert', async (t) => {
  const f = await fixture(t);
  const events = [];
  const bridge = adapter(f, { ...f.baseline, hasAdjustments: true }, events);
  let stopped = false;
  bridge.exportResult = async () => { events.push('export'); stopped = true; return { sha256: 'c'.repeat(64) }; };
  await assert.rejects(recoverPendingEdit({ pending: f.pending, filename: f.filename, bridge,
    verifyViewer: async () => {}, persist: async () => assert.fail('must keep recovery pending'),
    stop: () => { if (stopped) throw new Error('stop requested'); } }), /stop requested/);
  assert.deepEqual(events, ['inspect', 'find', 'export']);
  assert(await readPendingEdit(f.filename));
});
