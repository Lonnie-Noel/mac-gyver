import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PhotoWorkflow, sha256, verifyJPEG } from '../scripts/workflow.mjs';
import { selectors } from '../scripts/core.mjs';

// Byte-transfer fixtures only. Full image decoding is intentionally delegated
// to the mocked native verifyJPEG command, whose decoder has separate tests.
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = Buffer.from([255, 216, 0x11, 0x22, 0x33, 255, 217]);
const ITEM = Object.freeze({ id: 'asset-one', filename: 'IMG_4321.JPG' });
const BASELINE = Object.freeze({ assetId: ITEM.id, originalFilename: ITEM.filename,
  originalSHA256: 'a'.repeat(64), currentSHA256: 'b'.repeat(64), hasAdjustments: false, width: 4000, height: 3000 });
const WINDOW = Object.freeze({ x: 100, y: 50, width: 1200, height: 900 });
const CONFIG = Object.freeze({ minimumGenerationSeconds: 25, generationTimeoutSeconds: 60,
  dragRadiusFactor: 0.5, dragDurationMs: 1500, pollIntervalMs: 1000, albumId: null });
const sameSelector = (a, b) => Object.entries(b).every(([key, value]) => a[key] === value);
const control = (selector, enabled = true) => ({ ...selector, enabled });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'macgyver-workflow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDir = path.join(directory, 'run');
  await mkdir(runDir);
  const pendingPath = path.join(directory, 'pending.json');
  const env = { stage: 'viewer', frontmost: true, selected: { ...ITEM }, edited: !!options.edited,
    clock: Date.UTC(2026, 0, 1), stop: false, calls: [], hook: null, pauseHook: null,
    exportError: null, verifyError: null, exportChanges: null, inspectChanges: null,
    corruptExport: false, draftApplied: false };
  const pending = async () => existsSync(pendingPath) ? JSON.parse(await readFile(pendingPath, 'utf8')) : null;
  const state = () => {
    const nodes = [];
    if (env.stage === 'viewer') nodes.push(control(selectors.edit));
    if (env.stage === 'editing' || env.stage === 'tools' || env.stage === 'applied') nodes.push(control(selectors.done));
    if (env.stage === 'editing') nodes.push(control(selectors.tools));
    if (env.stage === 'tools') nodes.push(control(selectors.reframe));
    if (['ready', 'dragged', 'generated'].includes(env.stage)) {
      nodes.push(control(selectors.cancel), control(selectors.save, env.stage === 'generated'));
      nodes.push(control(selectors.reframe, env.stage === 'dragged'));
      nodes.push({ identifier: 'IPXCanvasItemView', role: 'AXGroup', enabled: false,
        rect: { x: 200, y: 150, width: 1000, height: 700 } });
      if (env.stage === 'ready') nodes.push({ role: 'AXStaticText', value: '드래그하여 시점을 조절하십시오.' });
    }
    return { frontmost: env.frontmost, appPid: 123, window: { title: '사진', rect: { ...WINDOW } }, nodes, truncated: false };
  };
  const current = () => ({ ...BASELINE, hasAdjustments: env.edited,
    currentSHA256: env.edited ? 'c'.repeat(64) : BASELINE.currentSHA256 });
  const bridge = { async call(action, args = {}) {
    const call = { action, args: structuredClone(args), at: env.clock, stage: env.stage, pending: await pending() };
    env.calls.push(call);
    await env.hook?.(action, args, call);
    switch (action) {
      case 'snapshot': return state();
      case 'selection': return { items: env.selected ? [{ ...env.selected }] : [] };
      case 'activate':
        env.frontmost = true; return { activated: true };
      case 'show':
        assert.equal(args.id, ITEM.id, 'workflow must never navigate to a different asset in this single-photo test');
        env.selected = { ...ITEM }; env.stage = 'viewer'; env.frontmost = true; return { shown: true };
      case 'inspect': return { ...current(), ...env.inspectChanges };
      case 'press': {
        const selector = args.selector;
        if (sameSelector(selector, selectors.edit)) { assert.equal(env.stage, 'viewer'); env.stage = 'editing'; }
        else if (sameSelector(selector, selectors.tools)) { assert.equal(env.stage, 'editing'); env.stage = 'tools'; }
        else if (sameSelector(selector, selectors.reframe)) {
          if (env.stage === 'tools') env.stage = 'ready';
          else { assert.equal(env.stage, 'dragged'); env.stage = 'generated'; env.generationStarted = env.clock; }
        } else if (sameSelector(selector, selectors.save)) {
          assert.equal(env.stage, 'generated');
          assert.equal(call.pending?.phase, 'saving', 'durable pending journal must precede the first Save action');
          assert.equal(call.pending.baseline.assetId, ITEM.id);
          assert.ok(env.clock - env.generationStarted >= 25_000, 'early enabled Save must still wait the full 25 seconds');
          env.stage = 'applied'; env.draftApplied = true;
        } else if (sameSelector(selector, selectors.done)) {
          assert.ok(['editing', 'applied'].includes(env.stage));
          if (env.draftApplied) { env.edited = true; env.draftApplied = false; }
          env.stage = 'viewer';
        } else if (sameSelector(selector, selectors.cancel)) {
          assert.ok(['ready', 'dragged', 'generated'].includes(env.stage));
          env.stage = 'editing'; env.draftApplied = false;
        } else assert.fail(`unexpected selector ${JSON.stringify(selector)}`);
        return { pressed: true };
      }
      case 'drag':
        assert.equal(env.stage, 'ready');
        assert.ok(args.to.x < args.from.x && args.to.y > args.from.y);
        env.stage = 'dragged'; return { dragged: true };
      case 'capture':
        assert.ok(['dragged', 'generated'].includes(env.stage));
        await writeFile(args.path, PNG, { flag: 'wx' }); return { captured: true };
      case 'export': {
        if (env.exportError) throw env.exportError;
        assert.equal(env.edited, true, 'export must follow committed Save and Done');
        assert.equal(args.assetId, ITEM.id);
        const payload = env.corruptExport ? Buffer.from(JPEG).fill(0, 2, 3) : JPEG;
        await writeFile(args.path, payload, { flag: 'wx' });
        return { ...current(), path: args.path, sha256: sha256(JPEG), bytes: JPEG.length,
          width: 4000, height: 3000, ...env.exportChanges };
      }
      case 'verifyJPEG':
        if (env.verifyError) throw env.verifyError;
        assert.deepEqual(await readFile(args.path), JPEG);
        return { sha256: args.sha256, width: args.width, height: args.height };
      case 'revert':
        assert.equal(call.pending?.phase, 'reverting');
        assert.equal(args.assetId, ITEM.id);
        assert.equal(args.verifiedExportSHA256, sha256(JPEG));
        assert.ok(env.calls.some(entry => entry.action === 'verifyJPEG'));
        assert.ok(existsSync(args.path), 'verified JPEG must remain present while restoring');
        env.edited = false;
        return { ...current(), restored: true };
      default: assert.fail(`unexpected bridge command ${action}`);
    }
  } };
  const workflow = new PhotoWorkflow({ bridge, config: CONFIG, runDir, pendingPath,
    stopped: () => env.stop, log: () => {}, now: () => env.clock,
    pause: async milliseconds => { env.clock += milliseconds; await env.pauseHook?.(milliseconds); } });
  return { directory, runDir, pendingPath, pending, env, bridge, workflow };
}

const callsFor = (env, action) => env.calls.filter(call => call.action === action);
const pressCalls = (env, selector) => callsFor(env, 'press').filter(call => sameSelector(call.args.selector, selector));

test('one-photo workflow commits Save/Done, verifies JPEG before restoring, then removes the pending journal', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(result.restoreReceipt.restored, true);
  assert.equal(result.finalVerification.currentSHA256, BASELINE.currentSHA256);
  assert.equal(await pending(), null);
  const index = predicate => env.calls.findIndex(predicate);
  assert.ok(index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.save))
    < index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done)));
  assert.ok(index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done)) < index(call => call.action === 'export'));
  assert.ok(index(call => call.action === 'export') < index(call => call.action === 'verifyJPEG'));
  assert.ok(index(call => call.action === 'verifyJPEG') < index(call => call.action === 'revert'));
  assert.equal(callsFor(env, 'show').length, 1);
  assert.equal(callsFor(env, 'revert').length, 1);
  assert.deepEqual(await readFile(path.join(runDir, 'IMG_4321-result.jpg')), JPEG);
  assert.deepEqual(await readFile(path.join(runDir, 'IMG_4321-preview-capture.png')), PNG);
  const completion = JSON.parse(await readFile(path.join(runDir, '.metadata', 'IMG_4321-result.json'), 'utf8'));
  assert.equal(completion.status, 'complete');
});

test('opening waits for delayed foreground activation before inspecting or editing the exact photo', async t => {
  const { workflow, env, pending } = await fixture(t);
  let snapshots = 0;
  const openedAt = env.clock;
  env.hook = async action => {
    if (action !== 'snapshot') return;
    snapshots += 1;
    env.frontmost = snapshots > 2;
    if (!env.frontmost) {
      assert.equal(callsFor(env, 'inspect').length, 0);
      assert.equal(callsFor(env, 'press').length, 0);
      assert.equal(await pending(), null);
    }
  };
  assert.equal((await workflow.process(ITEM)).status, 'complete');
  assert.ok(callsFor(env, 'inspect')[0].at - openedAt >= 2 * CONFIG.pollIntervalMs);
  assert.equal(callsFor(env, 'show').length, 1, 'activation waits must not replay navigation');
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(await pending(), null);
});

test('opening times out without inspecting or editing when Photos never becomes frontmost', async t => {
  const { workflow, env, pending } = await fixture(t);
  const startedAt = env.clock;
  env.hook = async action => { if (action === 'snapshot') env.frontmost = false; };
  await assert.rejects(workflow.process(ITEM), /대기 시간초과: 사진 앱 전면 전환/);
  assert.equal(env.clock - startedAt, 30_000);
  assert.equal(callsFor(env, 'show').length, 1);
  for (const action of ['selection', 'inspect', 'press', 'drag', 'capture', 'export', 'revert']) {
    assert.equal(callsFor(env, action).length, 0);
  }
  assert.equal(await pending(), null);
});

test('foreground loss after initial activation is fatal before baseline inspection', async t => {
  const { workflow, env, pending } = await fixture(t);
  let snapshots = 0;
  env.hook = async action => {
    if (action === 'snapshot') env.frontmost = ++snapshots === 1;
  };
  await assert.rejects(workflow.process(ITEM), /사진 앱이 전면이 아니거나/);
  assert.equal(snapshots, 2, 'foreground loss after opening must not be retried');
  assert.equal(callsFor(env, 'inspect').length, 0);
  assert.equal(callsFor(env, 'press').length, 0);
  assert.equal(await pending(), null);
});

test('foreground loss in the editor stops immediately and preserves its pending journal', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async action => {
    if (action === 'snapshot' && env.stage === 'editing') env.frontmost = false;
  };
  await assert.rejects(workflow.process(ITEM), /사진 앱이 전면이 아니거나/);
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(pressCalls(env, selectors.tools).length, 0);
  assert.equal(callsFor(env, 'show').length, 1);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).baseline.assetId, ITEM.id);
});

test('export waits until PhotoKit reports the committed edit after two stale unedited inspections', async t => {
  const { workflow, env, pending } = await fixture(t);
  const committedFlags = [];
  env.hook = async (action, args, call) => {
    if (action === 'inspect' && env.edited && callsFor(env, 'export').length === 0) {
      const committed = committedFlags.length >= 2;
      committedFlags.push(committed);
      env.inspectChanges = committed ? null : { hasAdjustments: false, currentSHA256: BASELINE.currentSHA256 };
      assert.equal(call.pending.phase, 'saved');
      assert.equal(args.assetId, ITEM.id);
      assert.equal(args.baselineOriginalSHA256, BASELINE.originalSHA256);
      assert.equal(args.preserveBaseline, true);
      assert.equal(callsFor(env, 'export').length, 0);
    }
    if (action === 'export') {
      assert.deepEqual(committedFlags, [false, false, true], 'export must follow the positive committed-edit response');
      const done = pressCalls(env, selectors.done)[0];
      assert.ok(call.at - done.at >= CONFIG.pollIntervalMs * 2, 'two stale responses must cause two poll waits');
    }
  };
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.deepEqual(committedFlags, [false, false, true]);
  assert.equal(callsFor(env, 'export').length, 1);
  assert.equal(callsFor(env, 'revert').length, 1);
  assert.equal(await pending(), null);
});

test('an already edited photo is skipped before any UI edit or pending journal is created', async t => {
  const { workflow, env, pending } = await fixture(t, { edited: true });
  assert.equal((await workflow.process(ITEM)).status, 'skipped-existing-edits');
  assert.equal(await pending(), null);
  for (const action of ['press', 'drag', 'capture', 'export', 'verifyJPEG', 'revert']) assert.equal(callsFor(env, action).length, 0);
});

test('export failure retains the saved-photo journal and never restores without a JPEG', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.exportError = new Error('simulated export unavailable');
  await assert.rejects(workflow.process(ITEM), /export unavailable/);
  assert.equal((await pending()).phase, 'saved');
  assert.equal(env.edited, true);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('native JPEG decode failure preserves the pending edit and exported file without restoring', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  env.verifyError = new Error('simulated full decode failed');
  await assert.rejects(workflow.process(ITEM), /full decode failed/);
  assert.equal((await pending()).phase, 'saved');
  assert.equal(env.edited, true);
  assert.ok(existsSync(path.join(runDir, 'IMG_4321-result.jpg')));
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('transferred JPEG hash mismatch stops before native decode or restoration', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.corruptExport = true;
  await assert.rejects(workflow.process(ITEM), /JPEG 바이트 검증/);
  assert.equal((await pending()).phase, 'saved');
  assert.equal(callsFor(env, 'verifyJPEG').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('an initial library asset mismatch prevents UI editing entirely', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.inspectChanges = { assetId: 'different-asset' };
  await assert.rejects(workflow.process(ITEM), /사진 ID가 일치하지/);
  assert.equal(pressCalls(env, selectors.edit).length, 0);
  assert.equal(await pending(), null);
});

test('selection switching after generation prevents Save and preserves the original asset journal', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async (action, args) => {
    if (action === 'capture' && args.path.endsWith('-result-capture.png')) env.selected = { id: 'other-asset', filename: 'IMG_OTHER.JPG' };
  };
  await assert.rejects(workflow.process(ITEM), /저장 전에 사진/);
  assert.equal(pressCalls(env, selectors.save).length, 0);
  assert.equal(callsFor(env, 'export').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).baseline.assetId, ITEM.id);
  assert.equal((await pending()).phase, 'saving');
});

test('an export receipt for another asset prevents all restoration', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.exportChanges = { assetId: 'different-asset' };
  await assert.rejects(workflow.process(ITEM), /식별 검증 실패/);
  assert.equal((await pending()).phase, 'saved');
  assert.equal(callsFor(env, 'verifyJPEG').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('stop while waiting on a generated preview preserves recovery and never commits Save', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  env.pauseHook = async () => { if (env.stage === 'generated') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  assert.equal((await pending()).phase, 'generating');
  assert.equal(pressCalls(env, selectors.save).length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.ok(existsSync(path.join(runDir, 'IMG_4321-preview-capture.png')));
});

test('stop after verified export retains both JPEG and the exported receipt without beginning revert', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async action => { if (action === 'verifyJPEG') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  const record = await pending();
  assert.equal(record.phase, 'exported');
  assert.equal(record.exportReceipt.sha256, sha256(JPEG));
  assert.ok(existsSync(record.outputs.jpeg));
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('saved-photo recovery uses the exact recorded asset/hash and does not show a subsequent photo', async t => {
  const { workflow, env, pending, pendingPath, runDir, bridge } = await fixture(t);
  env.exportError = new Error('simulated crash after save');
  await assert.rejects(workflow.process(ITEM), /crash after save/);
  const record = await pending();
  assert.equal(record.phase, 'saved');
  env.exportError = null;
  env.frontmost = false; // A Terminal launcher is in front when recovery begins.
  env.calls.length = 0;
  const recoveredWorkflow = new PhotoWorkflow({ bridge, config: CONFIG, runDir, pendingPath,
    stopped: () => false, log: () => {}, now: () => env.clock, pause: async milliseconds => { env.clock += milliseconds; } });
  const result = await recoveredWorkflow.recover(record);
  assert.equal(result.status, 'complete');
  assert.equal(await pending(), null);
  assert.equal(callsFor(env, 'activate').length, 1);
  const activationIndex = env.calls.findIndex(call => call.action === 'activate');
  const firstSnapshotIndex = env.calls.findIndex(call => call.action === 'snapshot');
  assert.ok(activationIndex >= 0 && activationIndex < firstSnapshotIndex,
    'recovery must activate Photos before reading its foreground-dependent UI');
  assert.deepEqual(callsFor(env, 'show').map(call => call.args.id), [ITEM.id]);
  for (const call of callsFor(env, 'inspect')) {
    assert.equal(call.args.assetId, ITEM.id);
    assert.equal(call.args.expectedOriginalFilename, ITEM.filename);
    assert.equal(call.args.baselineOriginalSHA256, BASELINE.originalSHA256);
    assert.equal(call.args.preserveBaseline, true);
  }
  assert.equal(pressCalls(env, selectors.edit).length, 0);
  assert.equal(pressCalls(env, selectors.save).length, 0);
  assert.equal(callsFor(env, 'revert').length, 1);
});

test('recovery identity mismatch leaves the journal intact and never navigates or restores', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.exportError = new Error('crash');
  await assert.rejects(workflow.process(ITEM), /crash/);
  const record = await pending();
  env.calls.length = 0;
  env.inspectChanges = { originalSHA256: 'd'.repeat(64) };
  await assert.rejects(workflow.recover(record), /식별 검증 실패/);
  assert.equal((await pending()).baseline.originalSHA256, BASELINE.originalSHA256);
  assert.equal(callsFor(env, 'show').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('recovery refuses an ambiguous outer editor without pressing Done or changing the pending record', async t => {
  const { workflow, env, pending, pendingPath } = await fixture(t);
  env.pauseHook = async () => { if (env.stage === 'generated') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  const record = await pending();
  const savedRecord = await readFile(pendingPath, 'utf8');
  env.stop = false;
  env.pauseHook = null;
  env.stage = 'editing'; // Could now contain an unrelated unsaved manual edit.
  env.frontmost = false;
  env.calls.length = 0;
  await assert.rejects(workflow.recover(record), /미저장 편집 화면/);
  assert.equal(await readFile(pendingPath, 'utf8'), savedRecord);
  assert.equal(env.stage, 'editing');
  assert.equal(callsFor(env, 'activate').length, 1);
  assert.equal(callsFor(env, 'activate')[0].stage, 'editing', 'activation must leave the current editor intact');
  for (const action of ['press', 'show', 'export', 'verifyJPEG', 'revert']) assert.equal(callsFor(env, action).length, 0);
});

test('recovery cancels its Reframe modal and verifies unchanged content before exiting without a result', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  env.pauseHook = async () => { if (env.stage === 'generated') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  const record = await pending();
  assert.equal(record.phase, 'generating');
  assert.equal(env.stage, 'generated');
  env.stop = false;
  env.pauseHook = null;
  env.frontmost = false;
  env.calls.length = 0;
  const result = await workflow.recover(record);
  assert.equal(result.status, 'recovered-without-result');
  assert.equal(result.finalVerification.hasAdjustments, false);
  assert.equal(result.finalVerification.currentSHA256, BASELINE.currentSHA256);
  assert.equal(await pending(), null);
  assert.equal(callsFor(env, 'activate').length, 1);
  assert.equal(callsFor(env, 'activate')[0].stage, 'generated', 'activation must preserve the pending Reframe modal');
  assert.equal(pressCalls(env, selectors.cancel).length, 1);
  assert.equal(pressCalls(env, selectors.done).length, 1);
  assert.equal(pressCalls(env, selectors.save).length, 0);
  const cancelIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.cancel));
  const doneIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done));
  assert.ok(env.calls.slice(cancelIndex + 1, doneIndex).some(call => call.action === 'inspect'
    && call.args.assetId === ITEM.id && call.args.baselineOriginalSHA256 === BASELINE.originalSHA256
    && call.args.preserveBaseline === true), 'recovery must recheck stored photo bytes between Cancel and Done');
  for (const action of ['export', 'verifyJPEG', 'revert']) assert.equal(callsFor(env, action).length, 0);
  assert.deepEqual(callsFor(env, 'show').map(call => call.args.id), [ITEM.id]);
  assert.equal(existsSync(record.outputs.jpeg), false);
  const completion = JSON.parse(await readFile(path.join(runDir, '.metadata', 'IMG_4321-recovery.json'), 'utf8'));
  assert.equal(completion.status, 'recovered-without-result');
});

test('JPEG verification rejects a mismatched destination before asking native code to decode', async t => {
  const { bridge, env, runDir } = await fixture(t);
  const expectedPath = path.join(runDir, 'expected-result.jpg');
  await assert.rejects(verifyJPEG(bridge, { path: path.join(runDir, 'different.jpg'),
    sha256: sha256(JPEG), bytes: JPEG.length, width: 4000, height: 3000 }, expectedPath), /요청 경로/);
  assert.equal(callsFor(env, 'verifyJPEG').length, 0);
});
