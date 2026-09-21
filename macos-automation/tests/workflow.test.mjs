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
// Keep the observed UI attributes independent of production selectors. The Tools
// entry has AXTitle; the generation control in the modal has AXDescription only.
const REFRAME_ENTRY = Object.freeze({ role: 'AXButton', title: '프레임 재설정' });
const REFRAME_GENERATE = Object.freeze({ role: 'AXButton', description: '프레임 재설정' });
const REFRAME_RESET = Object.freeze({ role: 'AXButton', description: '재설정' });
const NEUTRAL_POSE = Object.freeze([0, 0, 0, 0, 0, 1.15]);
const poseControls = values => {
  const parent = 'window/sidebar/controls';
  let slider = 0;
  return [{ role: 'AXScrollArea', path: parent }, ...[
    ['AXButton', '회전'], ['AXSlider', '세로'], ['AXSlider', '가로'],
    ['AXButton', '패닝'], ['AXSlider', '세로'], ['AXSlider', '가로'],
    ['AXButton', '수평 맞추기'], ['AXSlider', ''], ['AXButton', '확대/축소'], ['AXSlider', ''],
  ].map(([role, description], index) => ({ role, description, enabled: true, parent, path: `${parent}/${index}`,
    ...(role === 'AXSlider' ? { value: values[slider++] } : {}) }))];
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'macgyver-workflow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDir = path.join(directory, 'run');
  await mkdir(runDir);
  const pendingPath = path.join(directory, 'pending.json');
  const env = { stage: 'viewer', frontmost: true, selected: { ...ITEM }, edited: !!options.edited,
    clock: Date.UTC(2026, 0, 1), stop: false, calls: [], hook: null, pauseHook: null,
    exportError: null, verifyError: null, exportChanges: null, inspectChanges: null,
    corruptExport: false, draftApplied: false, snapshotChanges: null, extraNodes: [],
    pose: [...(options.initialPose ?? NEUTRAL_POSE)], hint: options.hint !== false };
  const pending = async () => existsSync(pendingPath) ? JSON.parse(await readFile(pendingPath, 'utf8')) : null;
  const state = () => {
    const nodes = [];
    if (env.stage === 'viewer') nodes.push(control(selectors.edit));
    if (env.stage === 'editing' || env.stage === 'tools' || env.stage === 'applied') nodes.push(control(selectors.done));
    if (env.stage === 'editing') nodes.push(control(selectors.tools));
    if (env.stage === 'tools') nodes.push(control(REFRAME_ENTRY));
    if (['ready', 'dragged', 'generated'].includes(env.stage)) {
      nodes.push(control(selectors.cancel), control(selectors.save, env.stage === 'generated'));
      nodes.push(control(REFRAME_GENERATE, env.stage === 'dragged' || (env.stage === 'ready' && !env.hint)));
      nodes.push(control(REFRAME_RESET, env.pose.some((value, index) => Math.abs(value - NEUTRAL_POSE[index]) > 1e-6)));
      nodes.push(...poseControls(env.pose));
      nodes.push({ identifier: 'IPXCanvasItemView', role: 'AXGroup', enabled: false,
        rect: { x: 200, y: 150, width: 1000, height: 700 } });
      if (env.stage === 'ready' && env.hint) nodes.push({ role: 'AXStaticText', value: '드래그하여 시점을 조절하십시오.' });
    }
    return { frontmost: env.frontmost, appPid: 123, window: { title: '사진', rect: { ...WINDOW } },
      nodes: [...nodes, ...env.extraNodes], truncated: false, ...env.snapshotChanges };
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
        else if (sameSelector(selector, REFRAME_ENTRY)) {
          assert.equal(env.stage, 'tools'); env.stage = 'ready';
        } else if (sameSelector(selector, REFRAME_GENERATE)) {
          assert.equal(env.stage, 'dragged'); env.stage = 'generated'; env.generationStarted = env.clock;
        } else if (sameSelector(selector, REFRAME_RESET)) {
          assert.equal(env.stage, 'ready');
          if (!options.resetDoesNotChange) env.pose = [...NEUTRAL_POSE];
          env.hint = false;
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
        if (!options.noPoseChange) env.pose = [-12, 6.5, 0, 0, 0, NEUTRAL_POSE[5]];
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
      case 'retain':
        assert.equal(env.edited, true);
        assert.equal(args.assetId, ITEM.id);
        assert.equal(args.verifiedExportSHA256, sha256(JPEG));
        assert.deepEqual(await readFile(args.path), JPEG);
        return { ...current(), retained: true, path: args.path, sha256: args.verifiedExportSHA256, ...env.retainChanges };
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

test('legacy version-one recovery still fulfills its recorded restore contract after a saved edit', async t => {
  const { workflow, env, pending, pendingPath } = await fixture(t);
  env.exportError = new Error('crash after save');
  await assert.rejects(workflow.process(ITEM), /crash after save/);
  const record = await pending();
  record.version = 1;
  delete record.resultPolicy;
  await writeFile(pendingPath, JSON.stringify(record));
  env.exportError = null;
  const result = await workflow.recover(record);
  assert.equal(result.status, 'complete');
  assert.equal(result.restoreReceipt.restored, true);
  assert.equal(result.finalVerification.hasAdjustments, false);
  assert.equal(result.finalVerification.currentSHA256, BASELINE.currentSHA256);
  assert.equal(callsFor(env, 'revert').length, 1);
  assert.equal(await pending(), null);
});

for (const changed of [
  { hasAdjustments: false, currentSHA256: BASELINE.currentSHA256 },
  { hasAdjustments: true, currentSHA256: 'd'.repeat(64) },
]) {
  test(`retention refuses a post-export asset change and preserves recovery: ${changed.currentSHA256[0]}`, async t => {
    const { workflow, env, pending } = await fixture(t);
    env.hook = async action => { if (action === 'verifyJPEG') env.inspectChanges = changed; };
    await assert.rejects(workflow.process(ITEM), /남긴 편집 결과가 내보낸 이미지와 다릅니다/);
    assert.equal((await pending()).phase, 'exported');
    assert.ok(existsSync((await pending()).outputs.jpeg));
    assert.equal(callsFor(env, 'revert').length, 0);
  });
}

test('retry after an unsaved failure allocates a new output suffix without overwriting its preview', async t => {
  const { workflow, env, runDir } = await fixture(t);
  const old = path.join(runDir, 'IMG_4321-preview-capture.png');
  const evidence = Buffer.from('previous attempt');
  await writeFile(old, evidence);
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(result.outputBase, 'IMG_4321-002');
  assert.deepEqual(await readFile(old), evidence);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('recovery never interprets an unknown retention policy as authorization to restore', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.exportError = new Error('crash after save');
  await assert.rejects(workflow.process(ITEM), /crash after save/);
  const record = await pending();
  record.resultPolicy = 'unknown';
  env.exportError = null;
  env.calls.length = 0;
  await assert.rejects(workflow.recover(record), /보존 정책/);
  assert.equal(callsFor(env, 'export').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.ok(await pending());
});

test('one-photo workflow commits Save/Done, verifies JPEG, retains the edited asset and removes its pending journal', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(result.keptEdits, true);
  assert.equal(result.resultPolicy, 'keep-edits');
  assert.equal(result.phase, 'retained');
  assert.equal(result.retainReceipt.retained, true);
  assert.equal(result.restoreReceipt, undefined);
  assert.equal(result.finalVerification.hasAdjustments, true);
  assert.equal(result.finalVerification.currentSHA256, 'c'.repeat(64));
  assert.equal(env.edited, true);
  assert.equal(await pending(), null);
  const index = predicate => env.calls.findIndex(predicate);
  assert.ok(index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.save))
    < index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done)));
  assert.ok(index(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done)) < index(call => call.action === 'export'));
  assert.ok(index(call => call.action === 'export') < index(call => call.action === 'verifyJPEG'));
  assert.ok(index(call => call.action === 'verifyJPEG') < env.calls.findLastIndex(call => call.action === 'inspect'));
  assert.equal(callsFor(env, 'show').length, 1);
  assert.equal(callsFor(env, 'revert').length, 0);
  const entryPresses = pressCalls(env, REFRAME_ENTRY);
  const generationPresses = pressCalls(env, REFRAME_GENERATE);
  assert.equal(entryPresses.length, 1);
  assert.equal(generationPresses.length, 1);
  assert.deepEqual(entryPresses[0].args.selector, { ...REFRAME_ENTRY, enabled: true });
  assert.deepEqual(generationPresses[0].args.selector, { ...REFRAME_GENERATE, enabled: true });
  assert.equal(entryPresses[0].stage, 'tools');
  assert.equal(generationPresses[0].stage, 'dragged');
  const dragIndex = index(call => call.action === 'drag');
  const previewIndex = index(call => call.action === 'capture' && call.stage === 'dragged');
  assert.ok(index(call => call === entryPresses[0]) < dragIndex);
  assert.ok(dragIndex < previewIndex);
  assert.ok(previewIndex < index(call => call === generationPresses[0]));
  assert.deepEqual(await readFile(path.join(runDir, 'IMG_4321-result.jpg')), JPEG);
  assert.deepEqual(await readFile(path.join(runDir, 'IMG_4321-preview-capture.png')), PNG);
  const completion = JSON.parse(await readFile(path.join(runDir, '.metadata', 'IMG_4321-result.json'), 'utf8'));
  assert.equal(completion.status, 'complete');
});

const EDIT_PRESS_ERROR = 'AX_PRESS_FAILED: AXPress 실패: -25205';

test('a cached Reframe pose is reset exactly once and verified neutral before a new drag', async t => {
  const { workflow, env, pending } = await fixture(t, { initialPose: [15, -8, 0, 0, 0, 1.15], hint: false });
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(pressCalls(env, REFRAME_RESET).length, 1);
  const resetIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, REFRAME_RESET));
  const dragIndex = env.calls.findIndex(call => call.action === 'drag');
  assert.ok(resetIndex < dragIndex);
  assert.ok(env.calls.slice(resetIndex + 1, dragIndex).some(call => call.action === 'snapshot'));
  assert.deepEqual(callsFor(env, 'drag')[0].pending.poseBeforeDrag, NEUTRAL_POSE);
  assert.deepEqual(result.poseBeforeDrag, NEUTRAL_POSE);
  assert.deepEqual(result.poseAfterDrag, [-12, 6.5, 0, 0, 0, 1.15]);
  assert.deepEqual(callsFor(env, 'capture')[0].pending.poseAfterDrag, result.poseAfterDrag);
  assert.equal(await pending(), null);
});

test('a neutral reopened modal works without instructional text and does not reset again', async t => {
  const { workflow, env } = await fixture(t, { hint: false });
  assert.equal((await workflow.process(ITEM)).status, 'complete');
  assert.equal(pressCalls(env, REFRAME_RESET).length, 0);
  assert.equal(callsFor(env, 'drag').length, 1);
});

test('an enabled generation button without actual pose change cannot capture or generate a result', async t => {
  const { workflow, env, pending } = await fixture(t, { noPoseChange: true, hint: false });
  await assert.rejects(workflow.process(ITEM), /대기 시간초과: 실제 구도 변경/);
  assert.equal(callsFor(env, 'drag').length, 1);
  assert.equal(env.clock - callsFor(env, 'drag')[0].at, 30_000);
  assert.equal(pressCalls(env, REFRAME_GENERATE).length, 0);
  for (const action of ['capture', 'export', 'revert']) assert.equal(callsFor(env, action).length, 0);
  assert.deepEqual((await pending()).poseBeforeDrag, NEUTRAL_POSE);
  assert.equal((await pending()).poseAfterDrag, undefined);
  assert.equal((await pending()).phase, 'editing');
});

test('a reset that leaves the cached pose unchanged stops without replaying reset or dragging', async t => {
  const { workflow, env, pending } = await fixture(t, {
    initialPose: [15, -8, 0, 0, 0, 1.15], hint: true, resetDoesNotChange: true,
  });
  await assert.rejects(workflow.process(ITEM), /대기 시간초과: 기본 구도 초기화/);
  assert.equal(pressCalls(env, REFRAME_RESET).length, 1);
  for (const action of ['drag', 'capture', 'export', 'revert']) assert.equal(callsFor(env, action).length, 0);
  assert.equal((await pending()).phase, 'editing');
});

test('Edit returning attributeUnsupported after opening the exact editor is verified without replay and recorded before Tools', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  env.hook = async (action, args, call) => {
    if (action !== 'press') return;
    if (sameSelector(args.selector, selectors.edit)) {
      assert.equal(call.pending.phase, 'editing');
      env.stage = 'editing';
      throw new Error(EDIT_PRESS_ERROR);
    }
    if (sameSelector(args.selector, selectors.tools)) {
      assert.equal(call.pending.editConfirmation.pressError, EDIT_PRESS_ERROR);
      assert.equal(call.pending.editConfirmation.assetId, ITEM.id);
      assert.equal(call.pending.editConfirmation.appPid, 123);
      assert.deepEqual(call.pending.editConfirmation.window, WINDOW);
      assert.ok(Number.isFinite(Date.parse(call.pending.editConfirmation.confirmedAt)));
    }
  };
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(result.editConfirmation.pressError, EDIT_PRESS_ERROR);
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(pressCalls(env, selectors.tools).length, 1);
  assert.equal(await pending(), null);
  const completion = JSON.parse(await readFile(path.join(runDir, '.metadata', 'IMG_4321-result.json'), 'utf8'));
  assert.deepEqual(completion.editConfirmation, result.editConfirmation);
});

test('Edit attributeUnsupported without a transition stops after five seconds and keeps the pending journal', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async (action, args) => {
    if (action === 'press' && sameSelector(args.selector, selectors.edit)) throw new Error(EDIT_PRESS_ERROR);
  };
  await assert.rejects(workflow.process(ITEM), /AX_PRESS_FAILED: AXPress 실패: -25205; 화면 전환을 확인하지 못했습니다: 대기 시간초과/);
  assert.equal(env.clock - pressCalls(env, selectors.edit)[0].at, 5_000);
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(pressCalls(env, selectors.tools).length, 0);
  assert.equal(callsFor(env, 'drag').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).baseline.assetId, ITEM.id);
  assert.equal((await pending()).editConfirmation, undefined);
});

test('Done returning attributeUnsupported after committing the exact photo is verified without replay before export', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async (action, args, call) => {
    if (action !== 'press' || !sameSelector(args.selector, selectors.done)) return;
    assert.equal(call.stage, 'applied');
    assert.equal(call.pending.phase, 'saving');
    env.edited = true;
    env.draftApplied = false;
    env.stage = 'viewer';
    throw new Error(EDIT_PRESS_ERROR);
  };
  const result = await workflow.process(ITEM);
  assert.equal(result.status, 'complete');
  assert.equal(result.doneConfirmation.pressError, EDIT_PRESS_ERROR);
  assert.equal(result.doneConfirmation.assetId, ITEM.id);
  assert.equal(result.doneConfirmation.appPid, 123);
  assert.deepEqual(result.doneConfirmation.window, WINDOW);
  assert.equal(pressCalls(env, selectors.done).length, 1);
  const doneIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done));
  const exportIndex = env.calls.findIndex(call => call.action === 'export');
  assert.ok(exportIndex > doneIndex);
  const verification = env.calls.slice(doneIndex + 1, exportIndex);
  assert.ok(verification.some(call => call.action === 'snapshot'));
  assert.ok(verification.some(call => call.action === 'selection'));
  assert.ok(verification.every(call => ['snapshot', 'selection', 'inspect'].includes(call.action)),
    'Done must not be replayed or followed by another UI mutation after an ambiguous response');
  assert.equal(callsFor(env, 'export').length, 1);
  assert.deepEqual(callsFor(env, 'export')[0].pending.doneConfirmation, result.doneConfirmation,
    'the confirmed ambiguous transition must be journaled before exporting');
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal(await pending(), null);
});

test('Done attributeUnsupported without leaving the editor times out and preserves the saved draft journal', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async (action, args) => {
    if (action === 'press' && sameSelector(args.selector, selectors.done)) throw new Error(EDIT_PRESS_ERROR);
  };
  await assert.rejects(workflow.process(ITEM), /AX_PRESS_FAILED: AXPress 실패: -25205; 화면 전환을 확인하지 못했습니다: 대기 시간초과/);
  assert.equal(env.clock - pressCalls(env, selectors.done)[0].at, 5_000);
  assert.equal(pressCalls(env, selectors.done).length, 1);
  assert.equal(env.stage, 'applied');
  assert.equal(env.draftApplied, true);
  assert.equal(callsFor(env, 'export').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'saving');
  assert.equal((await pending()).baseline.assetId, ITEM.id);
});

for (const scenario of [
  { name: 'foreground loss', change: env => { env.frontmost = false; }, error: /전면이 아니거나/ },
  { name: 'a different photo ID', change: env => { env.selected.id = 'another-asset'; }, error: /선택한 사진이 바뀌었습니다/ },
  { name: 'a different filename', change: env => { env.selected.filename = 'OTHER.JPG'; }, error: /선택한 사진이 바뀌었습니다/ },
  { name: 'a different Photos process', change: env => { env.snapshotChanges = { appPid: 124 }; }, error: /사진 앱이나 창이 바뀌었습니다/ },
  { name: 'a moved window', change: env => { env.snapshotChanges = { window: { title: '사진', rect: { ...WINDOW, x: WINDOW.x + 10 } } }; }, error: /사진 앱이나 창이 바뀌었습니다/ },
]) {
  test(`Done error verification rejects ${scenario.name} without export or another mutation`, async t => {
    const { workflow, env, pending } = await fixture(t);
    env.hook = async (action, args) => {
      if (action !== 'press' || !sameSelector(args.selector, selectors.done)) return;
      env.stage = 'viewer';
      env.edited = true;
      env.draftApplied = false;
      scenario.change(env);
      throw new Error(EDIT_PRESS_ERROR);
    };
    await assert.rejects(workflow.process(ITEM), error => {
      assert.ok(error.message.startsWith(`${EDIT_PRESS_ERROR}; 화면 전환을 확인하지 못했습니다:`));
      assert.match(error.message, scenario.error);
      return true;
    });
    assert.equal(env.clock, pressCalls(env, selectors.done)[0].at);
    assert.equal(pressCalls(env, selectors.done).length, 1);
    assert.equal(callsFor(env, 'export').length, 0);
    assert.equal(callsFor(env, 'revert').length, 0);
    assert.equal((await pending()).phase, 'saving');
    assert.equal((await pending()).baseline.assetId, ITEM.id);
  });
}

test('Done does not suppress an unapproved error even if the viewer appeared', async t => {
  const { workflow, env, pending } = await fixture(t);
  const failure = new Error('AX_PRESS_FAILED: AXPress 실패: -25202');
  env.hook = async (action, args) => {
    if (action !== 'press' || !sameSelector(args.selector, selectors.done)) return;
    env.stage = 'viewer'; env.edited = true; env.draftApplied = false;
    throw failure;
  };
  await assert.rejects(workflow.process(ITEM), error => error === failure);
  const doneIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.done));
  assert.equal(env.calls.length, doneIndex + 1);
  assert.equal(callsFor(env, 'export').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'saving');
});

for (const scenario of [
  { name: 'foreground loss', change: env => { env.frontmost = false; }, error: /전면이 아니거나/ },
  { name: 'a different photo ID', change: env => { env.selected.id = 'another-asset'; }, error: /선택한 사진이 바뀌었습니다/ },
  { name: 'a different filename for the same ID', change: env => { env.selected.filename = 'OTHER.JPG'; }, error: /선택한 사진이 바뀌었습니다/ },
  { name: 'empty selection', change: env => { env.selected = null; }, error: /선택한 사진이 바뀌었습니다/ },
  { name: 'a moved window', change: env => { env.snapshotChanges = { window: { title: '사진', rect: { ...WINDOW, x: WINDOW.x + 10 } } }; }, error: /사진 앱이나 창이 바뀌었습니다/ },
  { name: 'a different Photos process', change: env => { env.snapshotChanges = { appPid: 124 }; }, error: /사진 앱이나 창이 바뀌었습니다/ },
  { name: 'an unexpected alert', change: env => { env.extraNodes = [{ role: 'AXSheet', enabled: true }]; }, error: /예상 밖 대화상자/ },
  { name: 'a truncated snapshot', change: env => { env.snapshotChanges = { truncated: true }; }, error: /완전한 사진 앱 UI 정보/ },
]) {
  test(`Edit error verification rejects ${scenario.name} immediately without another mutation`, async t => {
    const { workflow, env, pending } = await fixture(t);
    env.hook = async (action, args) => {
      if (action !== 'press' || !sameSelector(args.selector, selectors.edit)) return;
      env.stage = 'editing';
      scenario.change(env);
      throw new Error(EDIT_PRESS_ERROR);
    };
    await assert.rejects(workflow.process(ITEM), error => {
      assert.ok(error.message.startsWith(`${EDIT_PRESS_ERROR}; 화면 전환을 확인하지 못했습니다:`));
      assert.match(error.message, scenario.error);
      return true;
    });
    assert.equal(env.clock, pressCalls(env, selectors.edit)[0].at, 'unsafe state must fail before any polling delay');
    assert.equal(callsFor(env, 'press').length, 1);
    assert.equal(callsFor(env, 'drag').length, 0);
    assert.equal(callsFor(env, 'revert').length, 0);
    assert.equal((await pending()).baseline.assetId, ITEM.id);
    assert.equal((await pending()).editConfirmation, undefined);
  });
}

for (const message of [
  'AX_PRESS_FAILED: AXPress 실패: -25202',
  'AX_PRESS_FAILED: AXPress 실패: -25204',
  'PRESS_UNSUPPORTED: 선택한 요소가 AXPress 동작을 제공하지 않습니다.',
  '보조 앱 응답 시간초과 (press). 요청을 자동 재전송하지 않습니다.',
  `${EDIT_PRESS_ERROR} unexpected suffix`,
]) {
  test(`Edit does not suppress an unapproved error even when the editor appeared: ${message}`, async t => {
    const { workflow, env, pending } = await fixture(t);
    const failure = new Error(message);
    env.hook = async (action, args) => {
      if (action !== 'press' || !sameSelector(args.selector, selectors.edit)) return;
      env.stage = 'editing';
      throw failure;
    };
    await assert.rejects(workflow.process(ITEM), error => error === failure);
    const dispatched = env.calls.findIndex(call => call.action === 'press');
    assert.equal(env.calls.length, dispatched + 1, 'unapproved errors must not enter postcondition verification');
    assert.equal(callsFor(env, 'press').length, 1);
    assert.equal((await pending()).phase, 'editing');
    assert.equal((await pending()).editConfirmation, undefined);
  });
}

test('a delayed editor transition after the allowed error only polls and never sends Edit again', async t => {
  const { workflow, env, pending } = await fixture(t);
  let editAt;
  let delayedTransitionPending = false;
  env.hook = async (action, args) => {
    if (action === 'press' && sameSelector(args.selector, selectors.edit)) {
      editAt = env.clock;
      delayedTransitionPending = true;
      throw new Error(EDIT_PRESS_ERROR);
    }
    if (action === 'snapshot' && delayedTransitionPending && env.clock - editAt >= 2_000) {
      env.stage = 'editing';
      delayedTransitionPending = false;
    }
    if (action === 'press' && sameSelector(args.selector, selectors.tools)) {
      assert.equal(env.clock - editAt, 2_000);
      assert.equal(pressCalls(env, selectors.edit).length, 1);
    }
  };
  assert.equal((await workflow.process(ITEM)).status, 'complete');
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  const editIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.edit));
  const toolsIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.tools));
  assert.ok(env.calls.slice(editIndex + 1, toolsIndex).every(call => ['snapshot', 'selection'].includes(call.action)));
  assert.equal(await pending(), null);
});

test('stopping while verifying an ambiguous Edit retains the journal and does not proceed to Tools', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async (action, args) => {
    if (action === 'press' && sameSelector(args.selector, selectors.edit)) throw new Error(EDIT_PRESS_ERROR);
  };
  env.pauseHook = async () => { env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /화면 전환을 확인하지 못했습니다: 중지 요청/);
  assert.equal(env.clock - pressCalls(env, selectors.edit)[0].at, CONFIG.pollIntervalMs);
  assert.equal(callsFor(env, 'press').length, 1);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).editConfirmation, undefined);
});

test('the same attributeUnsupported error on Tools remains fatal even if the Tools screen appeared', async t => {
  const { workflow, env, pending } = await fixture(t);
  const failure = new Error(EDIT_PRESS_ERROR);
  env.hook = async (action, args) => {
    if (action !== 'press' || !sameSelector(args.selector, selectors.tools)) return;
    env.stage = 'tools';
    throw failure;
  };
  await assert.rejects(workflow.process(ITEM), error => error === failure);
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(pressCalls(env, selectors.tools).length, 1);
  assert.equal(pressCalls(env, selectors.reframe).length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).editConfirmation, undefined);
});

test('normal Edit response still requires the editor postcondition and keeps its thirty-second timeout', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async action => {
    if (action === 'snapshot' && pressCalls(env, selectors.edit).length) env.stage = 'viewer';
  };
  await assert.rejects(workflow.process(ITEM), /^Error: 대기 시간초과: 같은 사진의 편집 화면$/);
  assert.equal(env.clock - pressCalls(env, selectors.edit)[0].at, 30_000);
  assert.equal(pressCalls(env, selectors.edit).length, 1);
  assert.equal(pressCalls(env, selectors.tools).length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).editConfirmation, undefined);
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

test('a stale AX element after Tools triggers a fresh tree read and never replays input', async t => {
  const { workflow, env, pending } = await fixture(t);
  let failedRead;
  env.hook = async (action, _args, call) => {
    if (action === 'snapshot' && env.stage === 'tools' && !failedRead) {
      failedRead = call;
      throw new Error('AX_READ_FAILED: AXSubrole 조회 실패: -25202');
    }
  };
  assert.equal((await workflow.process(ITEM)).status, 'complete');
  const failedIndex = env.calls.indexOf(failedRead);
  assert.ok(failedIndex >= 0);
  assert.equal(env.calls[failedIndex + 1].action, 'snapshot');
  assert.equal(env.calls[failedIndex + 1].at - failedRead.at, 250);
  for (const selector of [selectors.edit, selectors.tools, REFRAME_ENTRY, REFRAME_GENERATE, selectors.save, selectors.done]) {
    assert.equal(pressCalls(env, selector).length, 1, `no replay for ${JSON.stringify(selector)}`);
  }
  assert.equal(callsFor(env, 'show').length, 1);
  assert.equal(callsFor(env, 'drag').length, 1);
  assert.equal(callsFor(env, 'capture').length, 2);
  assert.equal(callsFor(env, 'export').length, 1);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal(await pending(), null);
});

test('a persistently stale AX tree stops after three reads without another input and retains recovery', async t => {
  const { workflow, env, pending } = await fixture(t);
  const failure = new Error('AX_READ_FAILED: AXSubrole 조회 실패: -25202');
  env.hook = async action => {
    if (action === 'snapshot' && env.stage === 'tools') throw failure;
  };
  await assert.rejects(workflow.process(ITEM), error => error === failure);
  const toolsIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.tools));
  const afterTools = env.calls.slice(toolsIndex + 1);
  assert.deepEqual(afterTools.map(call => call.action), ['snapshot', 'snapshot', 'snapshot']);
  assert.deepEqual(afterTools.map(call => call.at - afterTools[0].at), [0, 250, 500]);
  assert.equal(pressCalls(env, selectors.tools).length, 1);
  assert.equal(callsFor(env, 'drag').length, 0);
  assert.equal(callsFor(env, 'export').length, 0);
  assert.equal(callsFor(env, 'revert').length, 0);
  assert.equal((await pending()).phase, 'editing');
  assert.equal((await pending()).baseline.assetId, ITEM.id);
});

for (const message of [
  'AX_READ_FAILED: AXSubrole 조회 실패: -25200',
  'AX_READ_FAILED: AXSubrole 조회 실패: -25204',
  'AX_PRESS_FAILED: AXPress 실패: -25202',
  '보조 앱 응답 시간초과 (snapshot). 요청을 자동 재전송하지 않습니다.',
  'AX_READ_FAILED: AXSubrole 조회 실패: -25202 unexpected suffix',
]) {
  test(`snapshot reading never retries another error: ${message}`, async t => {
    const { workflow, env, pending } = await fixture(t);
    const failure = new Error(message);
    env.hook = async action => {
      if (action === 'snapshot' && env.stage === 'tools') throw failure;
    };
    await assert.rejects(workflow.process(ITEM), error => error === failure);
    const toolsIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.tools));
    assert.deepEqual(env.calls.slice(toolsIndex + 1).map(call => call.action), ['snapshot']);
    assert.equal(env.clock, env.calls[toolsIndex].at);
    assert.equal(callsFor(env, 'drag').length, 0);
    assert.equal((await pending()).phase, 'editing');
  });
}

for (const scenario of [
  { name: 'foreground loss', change: env => { env.frontmost = false; }, error: /전면이 아니거나/ },
  { name: 'an unexpected alert', change: env => { env.extraNodes = [{ role: 'AXSheet' }]; }, error: /예상 밖 대화상자/ },
  { name: 'an incomplete tree', change: env => { env.snapshotChanges = { truncated: true }; }, error: /완전한 사진 앱 UI 정보/ },
]) {
  test(`a fresh tree after a stale read still rejects ${scenario.name}`, async t => {
    const { workflow, env, pending } = await fixture(t);
    let toolsReads = 0;
    env.hook = async action => {
      if (action !== 'snapshot' || env.stage !== 'tools') return;
      toolsReads += 1;
      if (toolsReads === 1) throw new Error('AX_READ_FAILED: AXSubrole 조회 실패: -25202');
      scenario.change(env);
    };
    await assert.rejects(workflow.process(ITEM), scenario.error);
    assert.equal(toolsReads, 2);
    const toolsIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.tools));
    assert.deepEqual(env.calls.slice(toolsIndex + 1).map(call => call.action), ['snapshot', 'snapshot']);
    assert.equal(env.clock - env.calls[toolsIndex].at, 250);
    assert.equal(callsFor(env, 'drag').length, 0);
    assert.equal((await pending()).phase, 'editing');
  });
}

test('stop during a stale-tree retry prevents another read or input and keeps the journal', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.hook = async action => {
    if (action === 'snapshot' && env.stage === 'tools') throw new Error('AX_READ_FAILED: AXSubrole 조회 실패: -25202');
  };
  env.pauseHook = async () => { if (env.stage === 'tools') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  const toolsIndex = env.calls.findIndex(call => call.action === 'press' && sameSelector(call.args.selector, selectors.tools));
  assert.deepEqual(env.calls.slice(toolsIndex + 1).map(call => call.action), ['snapshot']);
  assert.equal(callsFor(env, 'drag').length, 0);
  assert.equal((await pending()).phase, 'editing');
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
  assert.equal(callsFor(env, 'revert').length, 0);
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
  assert.equal(callsFor(env, 'revert').length, 0);
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

test('recovery confirms an ambiguous Done after cancelling its modal without replay or export', async t => {
  const { workflow, env, pending, runDir } = await fixture(t);
  env.pauseHook = async () => { if (env.stage === 'generated') env.stop = true; };
  await assert.rejects(workflow.process(ITEM), /중지 요청/);
  const record = await pending();
  env.stop = false;
  env.pauseHook = null;
  env.calls.length = 0;
  env.hook = async (action, args, call) => {
    if (action !== 'press' || !sameSelector(args.selector, selectors.done)) return;
    assert.equal(call.stage, 'editing');
    assert.equal(env.draftApplied, false);
    assert.equal(pressCalls(env, selectors.cancel).length, 1);
    env.stage = 'viewer';
    throw new Error(EDIT_PRESS_ERROR);
  };
  const result = await workflow.recover(record);
  assert.equal(result.status, 'recovered-without-result');
  assert.equal(result.finalVerification.currentSHA256, BASELINE.currentSHA256);
  assert.equal(result.finalVerification.hasAdjustments, false);
  assert.equal(result.recoveryDoneConfirmation.pressError, EDIT_PRESS_ERROR);
  assert.equal(result.recoveryDoneConfirmation.assetId, ITEM.id);
  assert.equal(pressCalls(env, selectors.done).length, 1);
  for (const action of ['export', 'verifyJPEG', 'revert']) assert.equal(callsFor(env, action).length, 0);
  assert.equal(await pending(), null);
  const completion = JSON.parse(await readFile(path.join(runDir, '.metadata', 'IMG_4321-recovery.json'), 'utf8'));
  assert.deepEqual(completion.recoveryDoneConfirmation, result.recoveryDoneConfirmation);
});

test('JPEG verification rejects a mismatched destination before asking native code to decode', async t => {
  const { bridge, env, runDir } = await fixture(t);
  const expectedPath = path.join(runDir, 'expected-result.jpg');
  await assert.rejects(verifyJPEG(bridge, { path: path.join(runDir, 'different.jpg'),
    sha256: sha256(JPEG), bytes: JPEG.length, width: 4000, height: 3000 }, expectedPath), /요청 경로/);
  assert.equal(callsFor(env, 'verifyJPEG').length, 0);
});

test('invalid native retain receipt preserves the pending journal and edited result', async t => {
  const { workflow, env, pending } = await fixture(t);
  env.retainChanges = { retained: false };
  await assert.rejects(workflow.process(ITEM), /보존 완료 기록/);
  assert.equal((await pending()).phase, 'exported');
  assert.equal(env.edited, true);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('manifest completion failure keeps the pending journal after retained JPEG verification and recovers without re-export', async t => {
  const { workflow, env, pending, pendingPath, runDir } = await fixture(t);
  let completionAttempts = 0;
  workflow.onComplete = async result => {
    completionAttempts++;
    assert.equal(result.keptEdits, true);
    assert.equal(result.status, 'complete');
    assert.ok(existsSync(pendingPath), 'pending must survive until manifest persistence succeeds');
    assert.ok(existsSync(path.join(runDir, '.metadata', `${result.outputBase}-result.json`)));
    throw new Error('manifest storage full');
  };
  await assert.rejects(workflow.process(ITEM), /manifest storage full/);
  const record = await pending();
  assert.equal(record.phase, 'retained');
  assert.equal(env.edited, true);
  assert.equal(completionAttempts, 1);
  workflow.onComplete = async result => {
    completionAttempts++;
    assert.equal(result.item.id, ITEM.id);
    assert.ok(existsSync(pendingPath));
  };
  await workflow.recover(record);
  assert.equal(await pending(), null);
  assert.equal(completionAttempts, 2);
  assert.equal(callsFor(env, 'export').length, 1);
  assert.equal(callsFor(env, 'revert').length, 0);
});

test('legacy restored completion persists its callback before deleting pending', async t => {
  const { workflow, env, pending, pendingPath } = await fixture(t);
  env.exportError = new Error('stop before export');
  await assert.rejects(workflow.process(ITEM), /stop before export/);
  const record = await pending();
  record.version = 1;
  delete record.resultPolicy;
  await writeFile(pendingPath, JSON.stringify(record));
  env.exportError = null;
  workflow.onComplete = async result => {
    assert.equal(result.finalVerification.hasAdjustments, false);
    assert.ok(existsSync(pendingPath));
    throw new Error('legacy manifest unavailable');
  };
  await assert.rejects(workflow.recover(record), /legacy manifest unavailable/);
  assert.equal((await pending()).phase, 'restored');
  assert.equal(env.edited, false);
});

test('recovered-without-result completion also keeps pending until the manifest callback succeeds', async t => {
  const { workflow, env, pending, pendingPath, runDir } = await fixture(t);
  env.hook = async action => { if (action === 'drag') throw new Error('stop before drag'); };
  await assert.rejects(workflow.process(ITEM), /stop before drag/);
  const record = await pending();
  env.hook = null;
  workflow.onComplete = async result => {
    assert.equal(result.status, 'recovered-without-result');
    assert.ok(existsSync(pendingPath));
    assert.ok(existsSync(path.join(runDir, '.metadata', `${result.outputBase}-recovery.json`)));
    throw new Error('recovery manifest unavailable');
  };
  await assert.rejects(workflow.recover(record), /recovery manifest unavailable/);
  assert.ok(await pending());
  workflow.onComplete = async () => { assert.ok(existsSync(pendingPath)); };
  await workflow.recover(await pending());
  assert.equal(await pending(), null);
});


test('pre-edit inspection retries a transient coherent-read failure without replaying input', async t => {
  const { workflow, env, pending } = await fixture(t);
  let reads = 0;
  env.hook = async action => { if (action === 'inspect' && ++reads === 1) throw new Error('검사 중 사진이 변경되었습니다.'); };
  const baseline = await workflow.inspectBeforeEditing(ITEM);
  assert.equal(baseline.assetId, ITEM.id);
  assert.equal(reads, 2);
  assert.equal(await pending(), null);
  assert.ok(env.calls.every(c => ['snapshot', 'selection', 'inspect'].includes(c.action)));
});

test('pre-edit repeated changes stop after three reads; unrelated errors are not retried', async t => {
  for (const [message, count] of [['검사 중 사진이 변경되었습니다.', 3], ['권한 오류', 1]]) {
    const { workflow, env, pending } = await fixture(t);
    env.hook = async action => { if (action === 'inspect') throw new Error(message); };
    await assert.rejects(() => workflow.inspectBeforeEditing(ITEM), { message });
    assert.equal(callsFor(env, 'inspect').length, count);
    assert.equal(await pending(), null);
    assert.ok(env.calls.every(c => ['snapshot', 'selection', 'inspect'].includes(c.action)));
  }
});

test('pre-edit retry refuses a changed selection before reading or editing it', async t => {
  const { workflow, env } = await fixture(t);
  env.hook = async action => { if (action === 'inspect') { env.selected.id = 'other'; throw new Error('검사 중 사진이 변경되었습니다.'); } };
  await assert.rejects(() => workflow.inspectBeforeEditing(ITEM), /선택한 사진/);
  assert.equal(callsFor(env, 'inspect').length, 1);
  assert.equal(callsFor(env, 'press').length, 0);
});
