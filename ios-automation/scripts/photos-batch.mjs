import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { getSession, command, mobile, findElements, snapshot, snapshotFiles } from './phone.mjs';
import { evidencePaths, reserveCapturePaths } from './capture-storage.mjs';
import { extractOriginalFilename } from './photo-filename.mjs';
import { createExportBridge, verifyExportReceipt } from './export-bridge.mjs';
import { beginPendingEdit, updatePendingEdit, finishPendingEdit, pendingEditFile } from './edit-journal.mjs';

const APP = 'com.apple.mobileslideshow';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const EDIT = 'PUOneUpBarButtonItemIdentifierEdit';
const TOOLS = 'edit.tool.tools';
const INFO = 'PUOneUpBarButtonItemIdentifierToggleDetails';
const REFRAME = '프레임 재설정';
const now = () => new Date().toISOString();

// Read accessibility XML with a real parser (including numeric/XML entities).
// Never treat WDA element UUIDs as stable photo identifiers.
export function parseState(xml) {
  const doc = new DOMParser({ onError: (level, message) => {
    throw new Error(`Invalid accessibility XML (${level}): ${message}`);
  } }).parseFromString(xml, 'application/xml');
  const nodes = Array.from(doc.getElementsByTagName('*')).map((node) => {
    const result = { type: node.tagName };
    for (let i = 0; i < node.attributes.length; i++) {
      const item = node.attributes.item(i);
      result[item.name] = item.value;
    }
    return result;
  });
  const visible = nodes.filter((node) => node.visible === 'true');
  const has = (type, name, list = visible) => list.some((n) => n.type === type && n.name === name);
  const enabled = (type, name) => visible.some((n) => n.type === type && n.name === name && n.enabled === 'true');
  const disabled = (type, name) => visible.some((n) => n.type === type && n.name === name && n.enabled === 'false');
  const selectors = visible.filter((n) => n.name === '사진 선택기');
  let photo = null;
  if (selectors.length > 1) throw new Error('Ambiguous photo selector');
  if (selectors.length === 1) {
    const match = /^사진 총\s*(\d+)개 중\s*(\d+)$/.exec(selectors[0].value ?? '');
    if (!match) throw new Error(`Unknown photo selector: ${selectors[0].value}`);
    photo = { total: Number(match[1]), index: Number(match[2]) };
    if (photo.index < 1 || photo.index > photo.total) throw new Error('Invalid photo index');
  }
  const text = visible.map((n) => n.label || n.name || n.value || '').join('\n');
  const reframe = has('XCUIElementTypeOther', 'spatialReframeMediaView');
  const busy = /준비 중|생성 중|생성하는 중|재생성 중|처리 중|프레임을 재설정하는 중/.test(text)
    || visible.some((n) => n.type === 'XCUIElementTypeActivityIndicator' || n.type === 'XCUIElementTypeProgressIndicator');
  const alert = visible.some((n) => n.type === 'XCUIElementTypeAlert' || n.type === 'XCUIElementTypeSheet');
  const editing = enabled('XCUIElementTypeButton', TOOLS);
  return {
    nodes, visible, text, photo, reframe, busy, alert, editing,
    viewer: !!photo && has('XCUIElementTypeNavigationBar', 'PUOneUpView') && !reframe && !editing,
    editAvailable: nodes.some((n) => n.type === 'XCUIElementTypeButton' && n.name === EDIT && n.enabled === 'true'),
    toolsReady: enabled('XCUIElementTypeCell', REFRAME),
    reframeReady: reframe && !busy && /터치하고 드래그/.test(text),
    dragged: reframe && !busy && enabled('XCUIElementTypeButton', REFRAME),
    generated: reframe && !busy && has('XCUIElementTypeStaticText', 'editAIStatusViewCompleted')
      && enabled('XCUIElementTypeButton', 'Save'),
    cleanEditor: editing && !reframe && disabled('XCUIElementTypeButton', '완료')
      && disabled('XCUIElementTypeButton', '실행 취소'),
    saveEditorAvailable: editing && !reframe && enabled('XCUIElementTypeButton', '완료'),
    cancelAvailable: enabled('XCUIElementTypeButton', '취소'),
  };
}

export function buildOrder(total, startIndex) {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(startIndex)
      || startIndex < 1 || startIndex > total) throw new Error('Invalid total/start index');
  return Array.from({ length: total }, (_, offset) => (startIndex - 1 + offset) % total + 1);
}

function parseOptions(argv) {
  const options = { skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') return { help: true };
    if (!['--run-dir', '--total', '--start-index', '--skip', '--record-pilot', '--max-photos', '--fixture'].includes(key) || !argv[i + 1]) {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
    const value = argv[++i];
    if (key === '--skip') options.skip = value.split(',').map(Number);
    else options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  if (options.fixture) return options;
  if (!options.runDir || !options.total || !options.startIndex) throw new Error('Required: --run-dir PATH --total N --start-index N');
  options.runDir = path.resolve(options.runDir);
  options.total = Number(options.total);
  options.startIndex = Number(options.startIndex);
  if (options.recordPilot !== undefined) options.recordPilot = Number(options.recordPilot);
  if (options.maxPhotos !== undefined) options.maxPhotos = Number(options.maxPhotos);
  buildOrder(options.total, options.startIndex);
  if (options.skip.some((n) => !Number.isSafeInteger(n) || n < 1 || n > options.total)) throw new Error('Invalid --skip index');
  if (options.recordPilot !== undefined && (!Number.isSafeInteger(options.recordPilot) || options.recordPilot < 1 || options.recordPilot > options.total)) throw new Error('Invalid --record-pilot index');
  if (options.maxPhotos !== undefined && (!Number.isSafeInteger(options.maxPhotos) || options.maxPhotos < 1)) throw new Error('Invalid --max-photos count');
  return options;
}

async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

export async function validateCompleted(runDir, entry) {
  if (entry?.status !== 'complete' || entry.returnedToViewer !== true) return false;
  if (!(entry.beforeCapture && entry.afterCapture) && !(entry.before && entry.after)) return false;
  const files = evidencePaths(runDir, entry);
  for (const file of Object.values(files)) {
    if (!existsSync(file) || (await stat(file)).size === 0) return false;
  }
  for (const file of [files.beforeCapture, files.afterCapture]) {
    const png = await readFile(file);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  }
  const before = parseState(await readFile(files.beforeSource, 'utf8'));
  const after = parseState(await readFile(files.afterSource, 'utf8'));
  const generation = JSON.parse(await readFile(files.generation, 'utf8'));
  const startedAt = Date.parse(generation.startedAt);
  const capturedAt = (await stat(files.afterCapture)).mtimeMs;
  const capturesValid = before.dragged && after.generated && Number.isFinite(startedAt)
    && generation.minimumWaitSeconds >= 25 && capturedAt - startedAt >= 25_000
    && JSON.stringify(generation.drag) === JSON.stringify({ from: [201, 437], to: [5, 633], durationMs: 1500 });
  if (!capturesValid) return false;
  if (entry.outputMode === 'jpeg-export') {
    if (entry.restored !== true || !entry.exportReceipt) return false;
    await verifyExportReceipt(runDir, entry.exportReceipt);
  }
  return true;
}

async function run(options) {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const bundleId = (process.env.IOS_EXPORT_BUNDLE_ID ?? '').trim();
  const outputMode = bundleId ? 'jpeg-export' : 'captures';
  if (bundleId && options.recordPilot !== undefined) throw new Error('Legacy --record-pilot is only available in capture mode');
  if (existsSync(pendingEditFile)) throw new Error('A saved photo still needs recovery. Run npm run photos:recover before starting another batch.');
  await mkdir(options.runDir, { recursive: true });
  const manifestFile = path.join(options.runDir, 'manifest.json');
  const lockFile = path.join(options.runDir, '.batch.lock');
  const lock = await open(lockFile, 'wx');
  await lock.writeFile(`${process.pid}\n`);
  let manifest;
  let session;
  let bridge;
  let interrupted = false;
  let currentIndex = null;
  let currentEntry = null;
  const stopSignal = () => { interrupted = true; };
  process.on('SIGINT', stopSignal);
  process.on('SIGTERM', stopSignal);
  const stop = () => {
    if (interrupted || existsSync(path.join(options.runDir, 'STOP'))) throw new Error('Stopped: signal or run-directory STOP file');
  };
  const save = async () => { manifest.updatedAt = now(); await atomicJson(manifestFile, manifest); };
  const checkpoint = async (stage, details = {}) => {
    stop();
    manifest.stage = stage;
    manifest.currentIndex = currentIndex;
    if (currentEntry) Object.assign(currentEntry, { stage, updatedAt: now() }, details);
    await save();
    console.log(JSON.stringify({ time: now(), index: currentIndex, stage, ...details }));
  };
  const delay = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      stop();
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
    stop();
  };
  const read = async ({ allowAlert = false } = {}) => {
    stop();
    let app = await mobile(session, 'activeAppInfo');
    let systemOverlayCleared = false;
    const overlayDeadline = Date.now() + 20_000;
    while (app.bundleId === 'com.apple.springboard' && Date.now() < overlayDeadline) {
      await delay(1000);
      app = await mobile(session, 'activeAppInfo');
      systemOverlayCleared = true;
    }
    if (app.bundleId !== APP) throw new Error(`Photos left foreground: ${app.bundleId}`);
    const state = parseState(await command(session, 'GET', '/source'));
    if (state.alert && !allowAlert) throw new Error('Unexpected alert/sheet; no automatic response was sent');
    if (state.photo && state.photo.total !== options.total) throw new Error(`Album total changed: ${state.photo.total}`);
    return { ...state, systemOverlayCleared };
  };
  const viewer = (state, expectedIndex) => {
    if (!state.viewer || !state.editAvailable || state.photo?.total !== options.total || state.photo?.index !== expectedIndex) {
      throw new Error(`Expected viewer ${expectedIndex}/${options.total}; observed ${JSON.stringify(state.photo)}`);
    }
  };
  const poll = async (predicate, description, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    do {
      const state = await read();
      if (predicate(state)) return state;
      await delay(1000);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
  };
  const click = async (type, name, { visible = true } = {}) => {
    stop();
    await read();
    const literal = JSON.stringify(name);
    const predicate = `type == ${JSON.stringify(type)} AND name == ${literal} AND enabled == true${visible ? ' AND visible == true' : ''}`;
    const matches = await findElements(session, '-ios predicate string', predicate);
    if (matches.length !== 1) throw new Error(`Expected unique ${type}/${name}; found ${matches.length}`);
    stop();
    await command(session, 'POST', `/element/${matches[0][ELEMENT]}/click`, {});
  };
  const gesture = async (fromX, fromY, toX, toY, duration) => {
    stop();
    await command(session, 'POST', '/actions', { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: fromX, y: fromY },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration, origin: 'viewport', x: toX, y: toY },
      { type: 'pointerUp', button: 0 },
    ] }] });
    await command(session, 'DELETE', '/actions');
  };
  const capture = async (entry, phase) => {
    stop();
    await read();
    const files = evidencePaths(options.runDir, entry);
    const destination = phase === 'before'
      ? { source: files.beforeSource, screenshot: files.beforeCapture }
      : { source: files.afterSource, screenshot: files.afterCapture };
    for (let attempt = 0; attempt < 3; attempt++) {
      await snapshotFiles(session, destination);
      const after = await read();
      if (!after.systemOverlayCleared) return;
    }
    throw new Error('Repeated system notifications interrupted screenshot capture');
  };
  const navigate = async (target) => {
    let state = await read();
    if (!state.viewer || !state.photo) throw new Error('Navigation requires verified photo viewer');
    while (state.photo.index !== target) {
      const before = state.photo.index;
      const next = before + Math.sign(target - before);
      currentIndex = before;
      await checkpoint('before-navigation', { targetIndex: next });
      viewer(state, before);
      await mobile(session, 'swipe', { direction: next > before ? 'left' : 'right' });
      state = await poll((s) => {
        if (s.photo && s.photo.index !== before && s.photo.index !== next) throw new Error(`Unexpected photo jump ${before} -> ${s.photo.index}`);
        return s.viewer && s.photo?.index === next;
      }, `photo ${next}/${options.total}`, 15_000);
      viewer(state, next);
      currentIndex = next;
      await checkpoint('navigation-verified');
    }
    return state;
  };
  const readFilename = async (index) => {
    const before = await read();
    viewer(before, index);
    let filename;
    await click('XCUIElementTypeButton', INFO, { visible: false });
    try {
      await poll((state) => {
        filename = extractOriginalFilename(before, state);
        return filename !== null;
      }, 'original filename in Photos information; an unambiguous filename is required', 10_000);
    } finally {
      // Only toggle the information panel; never alter the photo to learn its name.
      await click('XCUIElementTypeButton', INFO, { visible: false });
      const returned = await poll((state) => state.viewer && state.photo?.index === index
        && extractOriginalFilename(before, state) === null, 'photo viewer after information', 15_000);
      viewer(returned, index);
    }
    return filename;
  };
  try {
    manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : {
      version: 2, createdAt: now(), total: options.total, startIndex: options.startIndex, outputMode, photos: {},
      gesture: { from: [201, 437], to: [5, 633], durationMs: 1500 }, generationMinimumWaitMs: 25_000,
    };
    if (manifest.total !== options.total || manifest.startIndex !== options.startIndex || !manifest.photos) throw new Error('Run manifest total/start index mismatch');
    if ((manifest.outputMode ?? 'captures') !== outputMode) throw new Error('Output mode changed; use a new run folder instead of mixing capture and JPEG runs');
    for (const index of options.skip) {
      if (!await validateCompleted(options.runDir, manifest.photos[index])) throw new Error(`Cannot skip ${index}: verified completed manifest entry and captures required`);
    }
    session = await getSession();
    if (bundleId) bridge = createExportBridge({ session, bundleId, runDir: options.runDir });
    const rect = await command(session, 'GET', '/window/rect');
    if (rect.width !== 402 || rect.height !== 874 || rect.x !== 0 || rect.y !== 0) throw new Error(`Unvalidated screen geometry ${JSON.stringify(rect)}`);
    const initial = await read();
    if (!initial.viewer || !initial.photo) throw new Error('Resume requires the original photo viewer; cancel any unfinished edit manually first');
    currentIndex = initial.photo.index;
    if (manifest.error) {
      manifest.previousErrors = [...(manifest.previousErrors ?? []), manifest.error];
      delete manifest.error;
    }
    manifest.status = 'running';
    await checkpoint('started');
    if (options.recordPilot !== undefined) {
      const index = options.recordPilot;
      viewer(initial, index);
      const base = `photo-${String(index).padStart(3, '0')}`;
      const entry = {
        status: 'complete', index, attempt: 1, returnedToViewer: true, completedAt: now(), pilot: true,
        before: `${base}/before-generation`, after: `${base}/after-generation`, generation: `${base}/generation.json`,
      };
      if (!await validateCompleted(options.runDir, entry)) throw new Error('Pilot capture/XML/generation timing validation failed');
      manifest.photos[index] = entry;
      manifest.status = 'ready';
      await checkpoint('pilot-recorded');
      return;
    }
    let processed = 0;
    for (const index of buildOrder(options.total, options.startIndex)) {
      currentEntry = null;
      const oldEntry = manifest.photos[index];
      if (oldEntry?.status === 'skipped-existing-edits') continue;
      if (await validateCompleted(options.runDir, oldEntry)) continue;
      if (oldEntry?.status === 'complete') throw new Error(`Completed photo ${index} has missing capture files; refusing to overwrite`);
      await navigate(index);
      currentIndex = index;
      const attempt = (oldEntry?.attempt ?? 0) + 1;
      await checkpoint('before-filename');
      let originalFilename = await readFilename(index);
      const comparableName = (name) => name.normalize('NFC').replace(/\.(heic|heif|jpe?g|png|dng|tiff?|avif)$/iu, '').toLowerCase();
      if (oldEntry?.originalFilename && comparableName(oldEntry.originalFilename) !== comparableName(originalFilename)) {
        throw new Error(`Photo filename changed at index ${index}; refusing to resume a different photo`);
      }
      let baseline;
      if (bridge) {
        baseline = await bridge.inspect(originalFilename);
        viewer(await read(), index);
        if (oldEntry?.baseline && (baseline.assetId !== oldEntry.baseline.assetId
          || baseline.originalSHA256 !== oldEntry.baseline.originalSHA256)) {
          throw new Error(`Photo asset or original bytes changed at index ${index}; refusing to resume`);
        }
        if (baseline.hasAdjustments !== false) {
          if (baseline.hasAdjustments !== true) throw new Error('Cannot determine whether this photo already has edits');
          manifest.photos[index] = { index, originalFilename: baseline.originalFilename,
            status: 'skipped-existing-edits', outputMode, skippedAt: now(), reason: 'Existing edits would be lost by Revert to Original' };
          await checkpoint('photo-skipped', { skippedIndex: index, reason: 'existing-edits' });
          continue;
        }
        originalFilename = baseline.originalFilename;
      }
      const files = await reserveCapturePaths(options.runDir, { originalFilename, index, attempt });
      currentEntry = manifest.photos[index] = {
        status: 'running', index, attempt, outputMode, baseline, startedAt: now(), returnedToViewer: false,
        ...files,
        previousAttempts: oldEntry ? [...(oldEntry.previousAttempts ?? []), { ...oldEntry, previousAttempts: undefined }] : [],
      };
      manifest.version = 2;
      viewer(await read(), index);
      await checkpoint('before-edit');
      await click('XCUIElementTypeButton', EDIT, { visible: false });
      await poll((s) => s.editing, 'editing tools', 15_000);
      await checkpoint('before-tools');
      await click('XCUIElementTypeButton', TOOLS);
      await poll((s) => s.toolsReady, 'Reframe tool', 15_000);
      await checkpoint('before-reframe');
      await click('XCUIElementTypeCell', REFRAME);
      await poll((s) => s.reframeReady, 'Reframe preparation');
      await checkpoint('before-drag');
      await gesture(201, 437, 5, 633, 1500);
      await poll((s) => s.dragged, 'Reframe apply control', 15_000);
      await capture(currentEntry, 'before');
      await checkpoint('before-generation', { beforeCapturedAt: now() });
      await click('XCUIElementTypeButton', REFRAME);
      const generationStartedAt = now();
      await atomicJson(path.join(options.runDir, currentEntry.generation), {
        startedAt: generationStartedAt, minimumWaitSeconds: 25,
        drag: { from: [201, 437], to: [5, 633], durationMs: 1500 },
      });
      await checkpoint('generation-requested', { generationRequestedAt: generationStartedAt });
      await delay(25_000);
      await poll((s) => s.generated, 'photo regeneration completion', 180_000);
      await capture(currentEntry, 'after');
      await checkpoint('after-generation', { afterCapturedAt: now() });
      if (!(await read()).generated) throw new Error('Generated preview changed before cancellation');
      if (bridge) {
        stop();
        let pending = await beginPendingEdit({ runDir: options.runDir, index, total: options.total, baseline, entry: currentEntry, bundleId });
        await checkpoint('before-save-result');
        await click('XCUIElementTypeButton', 'Save');
        const saved = await poll((s) => s.viewer || s.saveEditorAvailable, 'applied Reframe preview', 20_000);
        if (!saved.viewer) await click('XCUIElementTypeButton', '완료');
        viewer(await poll((s) => s.viewer, 'saved photo viewer', 30_000), index);
        pending = await updatePendingEdit(pending, { phase: 'saved' });
        await checkpoint('result-saved');
        const receipt = await bridge.exportResult(baseline, currentEntry.outputBase);
        currentEntry.exportReceipt = receipt;
        pending = await updatePendingEdit(pending, { phase: 'exported', exportReceipt: receipt });
        await checkpoint('result-exported');
        await bridge.verifyLocalExport(receipt);
        stop();
        await bridge.revert(baseline, receipt);
        pending = await updatePendingEdit(pending, { phase: 'restored' });
        currentEntry.restored = true;
        viewer(await poll((s) => s.viewer, 'restored photo viewer', 30_000), index);
        await checkpoint('original-restored');
        await finishPendingEdit(pending);
      } else {
        await checkpoint('before-cancel-generation');
        await click('XCUIElementTypeButton', '취소');
        await poll((s) => s.cleanEditor && s.cancelAvailable, 'unchanged editor after cancelling generated preview', 15_000);
        await checkpoint('before-cancel-editor', { generatedPreviewDiscardedAt: now() });
        await click('XCUIElementTypeButton', '취소');
      }
      const returned = await poll((s) => s.viewer, 'original photo viewer', 15_000);
      viewer(returned, index);
      await checkpoint('photo-complete', {
        status: 'complete', returnedToViewer: true, returnedIndex: returned.photo.index,
        returnedTotal: returned.photo.total, completedAt: now(),
      });
      if (!await validateCompleted(options.runDir, currentEntry)) throw new Error(`Completed artifact validation failed for photo ${index}`);
      processed++;
      if (options.maxPhotos !== undefined && processed >= options.maxPhotos) break;
    }
    currentEntry = null;
    const complete = buildOrder(options.total, options.startIndex).every((index) => ['complete', 'skipped-existing-edits'].includes(manifest.photos[index]?.status));
    manifest.status = complete ? 'complete' : 'paused';
    if (complete) manifest.completedAt = now();
    await checkpoint(complete ? 'complete' : 'paused-after-limit');
  } catch (error) {
    if (manifest) {
      manifest.status = interrupted || existsSync(path.join(options.runDir, 'STOP')) ? 'stopped' : 'failed';
      manifest.error = { at: now(), index: currentIndex, message: error.message };
      if (currentEntry) currentEntry.status = manifest.status;
      if (session) {
        const destination = `failures/${now().replace(/[:.]/g, '-')}`;
        try { await snapshot(session, path.join(options.runDir, destination)); manifest.error.evidence = destination; }
        catch (captureError) { manifest.error.captureError = captureError.message; }
      }
      await save();
    }
    throw error;
  } finally {
    process.off('SIGINT', stopSignal);
    process.off('SIGTERM', stopSignal);
    await lock.close();
    await unlink(lockFile);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/photos-batch.mjs --run-dir PATH --total N --start-index N [--skip N,N] [--max-photos N]\nResume completed photos from manifest.json. Create RUN_DIR/STOP to stop at the next stage.\n--record-pilot N validates existing pilot captures, timing and current viewer without UI actions.\n--fixture SOURCE_XML parses a captured UI fixture without device access.');
    return;
  }
  if (options.fixture) {
    const { nodes, visible, text, ...summary } = parseState(await readFile(options.fixture, 'utf8'));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  await run(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
