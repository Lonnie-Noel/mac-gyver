import { readFile, lstat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicJSON, privateDirectory, sleep } from './bridge.mjs';
import { readUI, selectors, photoFrame, dragGeometry, outputStem, verifyIdentity, sameRect } from './core.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyJPEG(bridge, receipt, expectedPath) {
  if (receipt.path !== expectedPath || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 4) throw new Error('JPEG 영수증이 요청 경로와 일치하지 않습니다.');
  const stat = await lstat(expectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== receipt.bytes) throw new Error('JPEG가 일반 파일이 아니거나 크기가 다릅니다.');
  const data = await readFile(expectedPath);
  if (data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217 || sha256(data) !== receipt.sha256) throw new Error('JPEG 바이트 검증에 실패했습니다. 원본 복원을 실행하지 않습니다.');
  const verified = await bridge.call('verifyJPEG', { path: expectedPath, sha256: receipt.sha256, bytes: receipt.bytes, width: receipt.width, height: receipt.height });
  if (verified.sha256 !== receipt.sha256 || verified.width !== receipt.width || verified.height !== receipt.height) throw new Error('JPEG 전체 디코딩 결과가 영수증과 다릅니다.');
  return verified;
}

export class PhotoWorkflow {
  constructor({ bridge, config, runDir, pendingPath, stopped = () => false, log = console.log, now = () => Date.now(), pause = sleep }) {
    Object.assign(this, { bridge, config, runDir, pendingPath, stopped, log, now, pause });
    this.used = new Set();
  }
  checkStop() { if (this.stopped()) throw new Error('중지 요청을 확인했습니다. 미완료 사진은 복구 기록을 유지합니다.'); }
  async poll(test, description, timeout = 30_000) {
    const deadline = this.now() + timeout;
    do {
      this.checkStop(); const result = await test(); if (result) return result;
      await this.pause(this.config.pollIntervalMs);
    } while (this.now() < deadline);
    throw new Error(`대기 시간초과: ${description}`);
  }
  async ui() {
    this.checkStop(); const snapshot = await this.bridge.call('snapshot'); const state = readUI(snapshot);
    if (!snapshot.frontmost || state.alert) throw new Error('사진 앱이 전면이 아니거나 예상 밖 대화상자가 열렸습니다.');
    return state;
  }
  async selected(item) {
    const { items } = await this.bridge.call('selection');
    return Array.isArray(items) && items.length === 1 && items[0].id === item.id && items[0].filename.normalize('NFC') === item.filename.normalize('NFC');
  }
  async show(item) {
    this.checkStop(); this.log(`사진 열기: ${item.filename}`);
    await this.bridge.call('show', { id: item.id });
    // Apple Events can return before Photos finishes becoming the front app.
    // Only this initial transition may wait; later foreground loss is fatal.
    await this.poll(async () => (await this.bridge.call('snapshot')).frontmost, '사진 앱 전면 전환');
    this.log(`지정한 사진의 보기 화면 확인 중: ${item.filename}`);
    await this.poll(async () => {
      const ui = await this.ui();
      return ui.viewer && await this.selected(item) ? ui : false;
    }, '지정한 사진 ID의 보기 화면');
  }
  async press(selector, expectedWindow) {
    const state = await this.ui();
    if (expectedWindow && !sameRect(state.snapshot.window.rect, expectedWindow)) throw new Error('사진 창 위치나 크기가 바뀌었습니다.');
    this.checkStop(); return this.bridge.call('press', { selector: { ...selector, enabled: true }, expectedWindow: expectedWindow ?? state.snapshot.window.rect });
  }
  async enterEditor(item) {
    const before = await this.ui();
    if (!before.viewer || !await this.selected(item)) throw new Error('편집 전에 선택한 사진이 바뀌었습니다.');
    let pressError;
    try { await this.press(selectors.edit, before.snapshot.window.rect); }
    catch (error) {
      // Photos can open its editor yet report attributeUnsupported from AXPress.
      // This observed Edit-only case is ambiguous: inspect, never press again.
      if (error.message !== 'AX_PRESS_FAILED: AXPress 실패: -25205') throw error;
      pressError = error;
    }
    try {
      await this.poll(async () => {
        const after = await this.ui();
        if (after.snapshot.appPid !== before.snapshot.appPid || !sameRect(after.snapshot.window.rect, before.snapshot.window.rect)) throw new Error('편집 화면 확인 중 사진 앱이나 창이 바뀌었습니다.');
        if (!await this.selected(item)) throw new Error('편집 화면 확인 중 선택한 사진이 바뀌었습니다.');
        return after.editing && !after.viewer && !after.modal;
      }, '같은 사진의 편집 화면', pressError ? 5_000 : 30_000);
    } catch (error) {
      if (pressError) throw new Error(`${pressError.message}; 화면 전환을 확인하지 못했습니다: ${error.message}`, { cause: error });
      throw error;
    }
    if (pressError) {
      this.log('편집 버튼이 오류를 반환했지만 같은 사진의 편집 화면 전환을 확인했습니다. 버튼을 다시 누르지 않습니다.');
      return { pressError: pressError.message, assetId: item.id, appPid: before.snapshot.appPid,
        window: before.snapshot.window.rect, confirmedAt: new Date(this.now()).toISOString() };
    }
  }
  async update(record, changes) {
    Object.assign(record, changes, { updatedAt: new Date(this.now()).toISOString() });
    await atomicJSON(this.pendingPath, record); return record;
  }
  identity(baseline) { return { assetId: baseline.assetId, expectedOriginalFilename: baseline.originalFilename, baselineOriginalSHA256: baseline.originalSHA256 }; }
  async capture(filename, expectedWindow) {
    const state = await this.ui();
    if (!sameRect(state.snapshot.window.rect, expectedWindow)) throw new Error('캡처 전에 창 크기가 바뀌었습니다.');
    await this.bridge.call('capture', { path: filename, expectedWindow });
    const bytes = await readFile(filename);
    if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PNG 캡처 검증에 실패했습니다.');
    return { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
  }
  async finishSaved(record) {
    this.checkStop();
    if (!record.exportReceipt) {
      const receipt = await this.bridge.call('export', { ...this.identity(record.baseline), path: record.outputs.jpeg });
      verifyIdentity(record.baseline, receipt);
      if (receipt.hasAdjustments !== true) throw new Error('저장된 편집 결과를 확인하지 못했습니다.');
      await verifyJPEG(this.bridge, receipt, record.outputs.jpeg);
      await this.update(record, { phase: 'exported', exportReceipt: receipt });
      this.log('JPEG 저장 및 전체 디코딩·해시 검증 완료');
    } else await verifyJPEG(this.bridge, record.exportReceipt, record.outputs.jpeg);
    this.checkStop();
    await this.update(record, { phase: 'reverting' });
    const restored = await this.bridge.call('revert', { ...this.identity(record.baseline), path: record.outputs.jpeg, verifiedExportSHA256: record.exportReceipt.sha256 });
    verifyIdentity(record.baseline, restored, { restored: true });
    if (restored.restored !== true) throw new Error('원본 복원 완료를 확인하지 못했습니다.');
    await this.update(record, { phase: 'restored', restoreReceipt: restored });
    await this.poll(async () => (await this.ui()).viewer && await this.selected(record.item), '복원 후 같은 사진 보기 화면');
    const final = await this.bridge.call('inspect', { ...this.identity(record.baseline), preserveBaseline: true });
    verifyIdentity(record.baseline, final, { restored: true });
    const result = { ...record, status: 'complete', completedAt: new Date(this.now()).toISOString(), finalVerification: final };
    await atomicJSON(path.join(this.runDir, '.metadata', `${record.outputBase}-result.json`), result);
    await unlink(this.pendingPath);
    this.log('원본 복원 및 편집 전 이미지 해시 일치 확인');
    return result;
  }
  async process(item) {
    if (existsSync(this.pendingPath)) throw new Error('미완료 사진 기록이 있습니다. recover를 먼저 실행하세요.');
    await this.show(item);
    this.log(`원본 사진과 기존 편집 여부 확인 중: ${item.filename}`);
    const baseline = await this.bridge.call('inspect', { assetId: item.id, expectedOriginalFilename: item.filename });
    if (baseline.assetId !== item.id || baseline.originalFilename.normalize('NFC') !== item.filename.normalize('NFC')) throw new Error('현재 Photos와 시스템 사진 보관함의 사진 ID가 일치하지 않습니다.');
    if (baseline.hasAdjustments === true) { this.log('기존 편집 사진 건너뜀'); return { item, status: 'skipped-existing-edits' }; }
    if (baseline.hasAdjustments !== false) throw new Error('기존 편집 여부를 판단하지 못했습니다.');
    if (!(await this.ui()).viewer || !await this.selected(item)) throw new Error('편집 전에 선택한 사진이 바뀌었습니다.');
    const outputBase = outputStem(baseline.originalFilename, this.used);
    const outputs = { preview: path.join(this.runDir, `${outputBase}-preview-capture.png`), resultCapture: path.join(this.runDir, `${outputBase}-result-capture.png`), jpeg: path.join(this.runDir, `${outputBase}-result.jpg`) };
    if (Object.values(outputs).some(existsSync)) throw new Error('기존 출력 파일을 덮어쓸 수 없습니다.');
    const record = { version: 1, item, baseline, outputBase, outputs, runDir: this.runDir, phase: 'editing', startedAt: new Date(this.now()).toISOString() };
    await atomicJSON(this.pendingPath, record, { exclusive: true });
    this.log(`편집 시작: ${baseline.originalFilename}`);
    const editConfirmation = await this.enterEditor(item);
    if (editConfirmation) await this.update(record, { editConfirmation });
    await this.press(selectors.tools); await this.poll(async () => (await this.ui()).tools, '도구 화면');
    await this.press(selectors.reframe);
    const prepared = await this.poll(async () => { const s=await this.ui(); return s.reframeReady ? s : false; }, '프레임 재설정 준비', this.config.generationTimeoutSeconds * 1000);
    const expectedWindow = prepared.snapshot.window.rect;
    const frame = photoFrame(prepared.snapshot, baseline.width, baseline.height);
    const geometry = dragGeometry(frame, this.config.dragRadiusFactor);
    await this.update(record, { drag: { ...geometry, durationMs: this.config.dragDurationMs }, expectedWindow });
    this.checkStop(); await this.bridge.call('drag', { ...geometry, durationMs: this.config.dragDurationMs, expectedWindow });
    await this.poll(async () => (await this.ui()).dragged, '구도 변경 후 프레임 재설정 버튼');
    const preview = await this.capture(outputs.preview, expectedWindow);
    await this.update(record, { phase: 'preview', preview });
    await this.press(selectors.reframe, expectedWindow);
    const generationStarted = this.now();
    await this.update(record, { phase: 'generating', generationStartedAt: new Date(generationStarted).toISOString() });
    this.log('프레임 재생성 중…');
    await this.poll(async () => {
      const ui=await this.ui(); return this.now()-generationStarted >= this.config.minimumGenerationSeconds*1000 && ui.generated;
    }, '최소 대기 및 실제 결과 저장 버튼 활성화', this.config.generationTimeoutSeconds * 1000);
    const resultCapture = await this.capture(outputs.resultCapture, expectedWindow);
    await this.update(record, { phase: 'saving', resultCapture });
    if (!(await this.ui()).generated || !await this.selected(item)) throw new Error('저장 전에 사진 또는 생성 결과가 바뀌었습니다.');
    await this.press(selectors.save, expectedWindow);
    const applied = await this.poll(async () => { const s=await this.ui(); return s.viewer || s.editing ? s : false; }, '생성 결과 적용');
    if (applied.editing) await this.press(selectors.done);
    await this.poll(async () => (await this.ui()).viewer && await this.selected(item), '변경사항 저장 완료');
    await this.update(record, { phase: 'saved' });
    await this.poll(async () => {
      const committed = await this.bridge.call('inspect', { ...this.identity(baseline), preserveBaseline: true });
      verifyIdentity(baseline, committed);
      return committed.hasAdjustments === true;
    }, '사진 보관함에 편집 결과 반영');
    return this.finishSaved(record);
  }
  async recover(record) {
    if (path.resolve(record.runDir) !== path.resolve(this.runDir)) throw new Error('복구 실행 폴더가 다릅니다.');
    if (record.baseline?.hasAdjustments !== false) throw new Error('편집 전 초기 기록이 유효하지 않습니다.');
    for (const filename of Object.values(record.outputs ?? {})) if (path.dirname(filename) !== this.runDir) throw new Error('복구 출력 경로가 실행 폴더 밖입니다.');
    const current = await this.bridge.call('inspect', { ...this.identity(record.baseline), preserveBaseline: true });
    verifyIdentity(record.baseline, current);
    this.checkStop();
    await this.bridge.call('activate');
    await this.poll(async () => (await this.bridge.call('snapshot')).frontmost, '복구를 위한 사진 앱 활성화');
    const ui = await this.ui();
    if (ui.editing && !ui.modal) {
      // PhotoKit only sees committed edits. It cannot tell whether this editor
      // contains our pending draft or a later manual change, so never press Done.
      throw new Error('복구 중 미저장 편집 화면을 발견했습니다. 이 작업의 결과라면 완료로 저장하고, 불필요한 초안이면 취소하여 사진 보기 화면으로 돌아온 뒤 recover를 다시 실행하세요. 기록은 보존했습니다.');
    }
    if (ui.modal) {
      if (!await this.selected(record.item)) throw new Error('다른 사진의 편집 화면이 열려 있습니다.');
      await this.press(selectors.cancel);
      const editor = await this.poll(async () => { const s=await this.ui(); return s.editing || s.viewer ? s : false; }, '저장되지 않은 초안 취소');
      if (editor.editing) {
        // Only dismiss our own editor after the Reframe draft is cancelled.
        // PhotoKit must still match the state observed before this UI cleanup.
        const check=await this.bridge.call('inspect',{...this.identity(record.baseline),preserveBaseline:true});
        if(check.currentSHA256!==current.currentSHA256 || check.hasAdjustments!==current.hasAdjustments)throw new Error('편집 정리 도중 사진이 변경됐습니다.');
        await this.press(selectors.done);
      }
    }
    await this.show(record.item);
    const actual = await this.bridge.call('inspect', { ...this.identity(record.baseline), preserveBaseline: true });
    verifyIdentity(record.baseline, actual);
    if (actual.hasAdjustments === true || record.exportReceipt) return this.finishSaved(record);
    verifyIdentity(record.baseline, actual, { restored: true });
    if (existsSync(record.outputs.jpeg)) {
      // A helper may have published the JPEG before the Mac journal was updated.
      // Ask it to reconcile its own export receipt; never delete that evidence.
      throw new Error('복구 JPEG는 있지만 영수증이 없습니다. 원본 상태는 확인했으며 기록을 보존합니다.');
    }
    const result={...record,status:'recovered-without-result',phase:'restored',finalVerification:actual};
    await atomicJSON(path.join(this.runDir,'.metadata',`${record.outputBase}-recovery.json`),result);
    await unlink(this.pendingPath);return result;
  }
}
