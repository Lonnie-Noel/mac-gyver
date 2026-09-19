import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  selectors, uniqueNode, sameRect, readUI, photoFrame, dragGeometry,
  rotateItems, outputStem, verifyIdentity, validateConfig,
} from '../scripts/core.mjs';

const rect = { x: 100, y: 50, width: 1200, height: 900 };
const snapshot = (nodes = [], windowRect = rect) => ({
  frontmost: true, appPid: 100, window: { title: '사진', rect: windowRect }, nodes, truncated: false,
});
const node = (selector, enabled = true, extra = {}) => ({ ...selector, enabled, ...extra });
const canvas = frame => node({ identifier: 'IPXCanvasItemView', role: 'AXGroup' }, false, { rect: frame });
const closeTo = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `expected ${actual} to be within ${tolerance} of ${expected}`);

test('default drag travels half the displayed photo short edge on a southwest 45° line', () => {
  const frame = { x: -800, y: 130, width: 1000, height: 600 };
  const drag = dragGeometry(frame);
  assert.deepEqual(drag.from, { x: -300, y: 430 });
  closeTo(drag.distance, 300);
  closeTo(Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y), 300);
  closeTo(drag.from.x - drag.to.x, drag.to.y - drag.from.y);
  assert.ok(drag.to.x < drag.from.x && drag.to.y > drag.from.y);
  assert.ok(drag.to.x > frame.x && drag.to.y < frame.y + frame.height);
  assert.deepEqual(drag.allowedRect, frame);
});

test('portrait and upper-radius drags stay inside the photo, independent of screen origin', () => {
  for (const frame of [
    { x: 0, y: 0, width: 300, height: 1000 },
    { x: 1400, y: -300, width: 1500, height: 200 },
  ]) {
    const drag = dragGeometry(frame, 0.65);
    closeTo(drag.distance, Math.min(frame.width, frame.height) * 0.65);
    assert.ok(drag.to.x > frame.x && drag.to.x < frame.x + frame.width);
    assert.ok(drag.to.y > frame.y && drag.to.y < frame.y + frame.height);
  }
});

test('drag rejects too-small views and invalid radius/geometry', () => {
  assert.throws(() => dragGeometry({ x: 0, y: 0, width: 149, height: 1000 }), /너무 작/);
  for (const factor of [0, -0.1, 0.651, Infinity, NaN]) assert.throws(() => dragGeometry(rect, factor));
  assert.throws(() => dragGeometry({ ...rect, x: Infinity }));
  assert.throws(() => dragGeometry({ ...rect, height: 0 }));
});

test('wide photo is aspect-fitted and vertically centered in the canvas', () => {
  const state = snapshot([canvas({ x: 200, y: 150, width: 1000, height: 700 })]);
  assert.deepEqual(photoFrame(state, 4000, 2000), { x: 200, y: 250, width: 1000, height: 500 });
});

test('tall photo is aspect-fitted and horizontally centered in the canvas', () => {
  const state = snapshot([canvas({ x: 200, y: 150, width: 1000, height: 700 })]);
  assert.deepEqual(photoFrame(state, 1000, 2000), { x: 525, y: 150, width: 350, height: 700 });
});

test('photoFrame uses global canvas coordinates on another display', () => {
  const windowRect = { x: -1500, y: -400, width: 1200, height: 900 };
  const state = snapshot([canvas({ x: -1400, y: -300, width: 1000, height: 700 })], windowRect);
  assert.deepEqual(photoFrame(state, 2000, 1000), { x: -1400, y: -200, width: 1000, height: 500 });
});

test('missing or ambiguous canvas is rejected, including disabled duplicate canvas nodes', () => {
  assert.throws(() => photoFrame(snapshot(), 4000, 3000), /유일/);
  const item = canvas({ x: 200, y: 150, width: 1000, height: 700 });
  assert.throws(() => photoFrame(snapshot([item, { ...item, enabled: true }]), 4000, 3000), /유일/);
});

test('photoFrame rejects invalid source dimensions and a fitted photo outside the window', () => {
  const state = snapshot([canvas(rect)]);
  for (const size of [[0, 10], [10, -1], [NaN, 10], [100.5, 10], [10, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => photoFrame(state, ...size));
  }
  assert.throws(() => photoFrame(snapshot([canvas({ x: 0, y: 0, width: 1200, height: 900 })]), 4, 3), /창 밖/);
  assert.throws(() => photoFrame(snapshot([canvas({ ...rect, width: NaN })]), 4, 3), /영역/);
});

test('enabled UI matching ignores disabled menu equivalents but refuses multiple enabled matches', () => {
  const enabled = node(selectors.reframe);
  const disabled = node(selectors.reframe, false, { path: 'menuBar/1/2' });
  assert.equal(uniqueNode(snapshot([disabled, enabled]), selectors.reframe), enabled);
  assert.throws(() => uniqueNode(snapshot([disabled]), selectors.reframe), /유일/);
  assert.throws(() => uniqueNode(snapshot([enabled, { ...enabled }]), selectors.reframe), /유일/);
  assert.throws(() => uniqueNode(snapshot([disabled, enabled]), selectors.reframe, { enabled: false }), /유일/);
});

test('a disabled Save button cannot mark the generated result complete', () => {
  const ui = readUI(snapshot([node(selectors.cancel), node(selectors.save, false)]));
  assert.equal(ui.modal, true);
  assert.equal(ui.generated, false);
  assert.equal(ui.viewer, false);
});

test('enabled Save is generated only after all busy indicators disappear', () => {
  const controls = [node(selectors.cancel), node(selectors.save)];
  assert.equal(readUI(snapshot(controls)).generated, true);
  const progress = readUI(snapshot([...controls, { role: 'AXProgressIndicator', enabled: false }]));
  assert.equal(progress.busy, true);
  assert.equal(progress.generated, false);
  for (const text of ['준비 중', '생성 중', '처리 중', '재생성 중']) {
    const ui = readUI(snapshot([...controls, { role: 'AXStaticText', value: text }]));
    assert.equal(ui.busy, true);
    assert.equal(ui.generated, false);
  }
});

test('ready Reframe instructions and enabled apply button distinguish pre-drag and post-drag', () => {
  const controls = [node(selectors.cancel), node(selectors.save, false)];
  const ready = readUI(snapshot([...controls, node(selectors.reframe, false),
    { role: 'AXStaticText', value: '드래그하여 시점을 조절하십시오.' }]));
  assert.equal(ready.reframeReady, true);
  assert.equal(ready.dragged, false);
  assert.equal(ready.generated, false);
  const dragged = readUI(snapshot([...controls, node(selectors.reframe)]));
  assert.equal(dragged.dragged, true);
  assert.equal(dragged.generated, false);
});

test('viewer/editor states use enabled controls rather than disabled menu text', () => {
  const viewer = readUI(snapshot([node(selectors.edit), node(selectors.done, false), node(selectors.reframe, false)]));
  assert.equal(viewer.viewer, true);
  assert.equal(viewer.editing, false);
  assert.equal(viewer.tools, false);
  const editor = readUI(snapshot([node(selectors.edit, false), node(selectors.done), node(selectors.reframe)]));
  assert.equal(editor.viewer, false);
  assert.equal(editor.editing, true);
  assert.equal(editor.tools, true);
});

test('sheet and dialog overlays are exposed as alerts for the orchestrator to reject', () => {
  for (const alert of [{ role: 'AXSheet' }, { role: 'AXWindow', subrole: 'AXDialog' }, { subrole: 'AXSystemDialog' }]) {
    assert.equal(readUI(snapshot([alert])).alert, true);
  }
  assert.equal(readUI(snapshot()).alert, false);
});

test('incomplete AX snapshots and invalid window geometry cannot drive a state transition', () => {
  assert.throws(() => readUI(null));
  assert.throws(() => readUI({ ...snapshot(), truncated: true }));
  assert.throws(() => readUI({ ...snapshot(), nodes: null }));
  assert.throws(() => readUI(snapshot([], { ...rect, width: 0 })));
  assert.equal(sameRect(rect, { ...rect, x: rect.x + 1 }), true);
  assert.equal(sameRect(rect, { ...rect, x: rect.x + 1.01 }), false);
  assert.equal(sameRect(rect, { ...rect, height: Infinity }), false);
});

const item = (id, filename = `${id}.JPG`) => Object.freeze({ id, filename });
test('album rotation preserves the frozen ID list and visits every photo once starting at selected ID', () => {
  const original = Object.freeze([item('a'), item('b'), item('c'), item('d')]);
  const rotated = rotateItems(original, 'c');
  assert.deepEqual(rotated.map(entry => entry.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(original.map(entry => entry.id), ['a', 'b', 'c', 'd']);
  assert.notEqual(rotated, original);
  assert.equal(new Set(rotated.map(entry => entry.id)).size, original.length);
  assert.equal(rotated[0], original[2]);
  assert.deepEqual(rotateItems(original, 'a'), original);
});

test('album ordering is based on asset IDs and permits repeated original filenames', () => {
  const items = Object.freeze([item('id-1', 'IMG_0001.JPG'), item('id-2', 'IMG_0001.JPG')]);
  assert.deepEqual(rotateItems(items, 'id-2').map(entry => entry.id), ['id-2', 'id-1']);
});

test('duplicate, missing, invalid, or unknown album IDs stop ordering', () => {
  for (const entries of [[], null, [item('a'), item('a')], [item('')], [{ id: 1, filename: 'x.jpg' }], [{ id: 'a' }]]) {
    assert.throws(() => rotateItems(entries, 'a'));
  }
  assert.throws(() => rotateItems([item('a'), item('b')], 'outside-album'));
});

test('output names cannot escape the output directory through separators, controls, or traversal', () => {
  for (const filename of ['../../IMG_1234.JPG', '..\\..\\IMG_1234.JPG', '/private/photo.jpg', 'a\0b\nc.jpg', 'x\u202ey.jpg']) {
    const stem = outputStem(filename);
    assert.equal(path.basename(stem), stem);
    assert.doesNotMatch(stem, /[\\/\x00-\x1f\x7f\u202a-\u202e]/u);
    assert.notEqual(stem, '.');
    assert.notEqual(stem, '..');
    assert.equal(path.dirname(path.resolve('/safe/output', `${stem}-result.jpg`)), '/safe/output');
  }
  for (const filename of ['', '.', '..', '...jpg', '   .jpg']) assert.throws(() => outputStem(filename));
});

test('case-insensitive and canonically equivalent Unicode output collisions get distinct names', () => {
  const used = new Set();
  assert.equal(outputStem('Re\u0301sume\u0301.JPG', used), 'Résumé');
  assert.equal(outputStem('RÉSUMÉ.heic', used), 'RÉSUMÉ-002');
  assert.equal(outputStem('résumé.PNG', used), 'résumé-003');
  assert.equal(used.size, 3);
  const camera = new Set();
  assert.equal(outputStem('IMG_1234.JPG', camera), 'IMG_1234');
  assert.equal(outputStem('img_1234.jpeg', camera), 'img_1234-002');
});

test('long Unicode output stems are limited by UTF-8 bytes without splitting a character', () => {
  const stem = outputStem(`${'📷한'.repeat(100)}.heic`);
  assert.ok(Buffer.byteLength(stem) <= 140);
  assert.equal(Buffer.from(stem).toString('utf8'), stem);
  assert.doesNotMatch(stem, /\ufffd/u);
  assert.ok(stem.length > 0);
});

const baseline = Object.freeze({ assetId: 'asset-1', originalFilename: 'IMG_0001.JPG',
  originalSHA256: 'a'.repeat(64), currentSHA256: 'b'.repeat(64), hasAdjustments: false });
test('export identity accepts an edited current image only when ID, filename and original hash match', () => {
  assert.doesNotThrow(() => verifyIdentity(baseline, { ...baseline, currentSHA256: 'c'.repeat(64), hasAdjustments: true }));
  for (const changes of [{ assetId: 'asset-2' }, { originalFilename: 'IMG_0002.JPG' }, { originalSHA256: 'd'.repeat(64) }]) {
    assert.throws(() => verifyIdentity(baseline, { ...baseline, ...changes }), /식별 검증/);
  }
  assert.throws(() => verifyIdentity({ ...baseline, assetId: '' }, baseline), /식별 검증/);
});

test('restoration requires both no adjustments and the exact pre-edit current-image hash', () => {
  assert.doesNotThrow(() => verifyIdentity(baseline, { ...baseline }, { restored: true }));
  for (const changes of [{ hasAdjustments: true }, { hasAdjustments: undefined }, { currentSHA256: 'c'.repeat(64) }, { currentSHA256: undefined }]) {
    assert.throws(() => verifyIdentity(baseline, { ...baseline, ...changes }, { restored: true }), /편집 전 이미지/);
  }
});

const config = () => ({ minimumGenerationSeconds: 25, generationTimeoutSeconds: 180,
  dragRadiusFactor: 0.5, dragDurationMs: 1500, pollIntervalMs: 1000, albumId: null });
test('configuration enforces at least 25 seconds generation wait and timeout not shorter than wait', () => {
  assert.doesNotThrow(() => validateConfig(config()));
  for (const minimumGenerationSeconds of [0, 24.999, NaN, Infinity, '25', 601]) {
    assert.throws(() => validateConfig({ ...config(), minimumGenerationSeconds }));
  }
  assert.throws(() => validateConfig({ ...config(), generationTimeoutSeconds: 24.99 }));
  assert.throws(() => validateConfig({ ...config(), minimumGenerationSeconds: 50, generationTimeoutSeconds: 49 }));
  assert.doesNotThrow(() => validateConfig({ ...config(), minimumGenerationSeconds: 50, generationTimeoutSeconds: 50 }));
});

test('configuration rejects unsafe drag/poll ranges and non-identifying album IDs', () => {
  for (const changes of [{ dragRadiusFactor: 0.01 }, { dragRadiusFactor: 0.66 },
    { dragDurationMs: 299 }, { dragDurationMs: 5001 }, { pollIntervalMs: 199 },
    { pollIntervalMs: 5001 }, { albumId: '' }, { albumId: '   ' }, { albumId: 1 }]) {
    assert.throws(() => validateConfig({ ...config(), ...changes }));
  }
  assert.doesNotThrow(() => validateConfig({ ...config(), albumId: 'album-1' }));
});
