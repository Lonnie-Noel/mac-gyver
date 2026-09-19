import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, command, mobile } from './phone.mjs';
import { parseState, validateCompleted } from './photos-batch.mjs';
import { createExportBridge } from './export-bridge.mjs';
import { readPendingEdit, recoverPendingEdit } from './edit-journal.mjs';

export async function recoverPhoto() {
  const workflowStop = fileURLToPath(new URL('../artifacts/.photos-workflow-stop', import.meta.url));
  const stop = () => { if (existsSync(workflowStop)) throw new Error('복구 중지를 요청받았습니다. 미완료 복구 기록을 유지합니다.'); };
  stop();
  const pending = await readPendingEdit();
  if (!pending) { console.log('복원이 필요한 사진 기록이 없습니다.'); return; }
  const session = await getSession();
  const bridge = createExportBridge({ session, bundleId: pending.bundleId, runDir: pending.runDir });
  const manifestFile = path.join(pending.runDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.total !== pending.total || !manifest.photos?.[pending.index]) throw new Error('Recovery manifest no longer matches the saved edit');
  const verifyViewer = async () => {
    const active = await mobile(session, 'activeAppInfo');
    if (active.bundleId !== 'com.apple.mobileslideshow') throw new Error('복구하려면 사진 앱의 해당 사진을 열어 주세요.');
    const state = parseState(await command(session, 'GET', '/source'));
    if (!state.viewer || state.photo?.total !== pending.total || state.photo?.index !== pending.index) {
      throw new Error(`복구 대상 ${pending.index}/${pending.total} 사진을 열어 주세요. 저장되지 않은 편집 초안이 남아 있으면 먼저 취소해 주세요.`);
    }
  };
  const result = await recoverPendingEdit({ pending, bridge, verifyViewer, stop, persist: async (record, receipt) => {
    const entry = manifest.photos[pending.index];
    Object.assign(entry, { restored: true, returnedToViewer: true, returnedIndex: pending.index,
      returnedTotal: pending.total, exportReceipt: receipt ?? undefined, recoveredAt: new Date().toISOString() });
    entry.status = receipt ? 'complete' : 'recovered-without-result';
    if (receipt && !await validateCompleted(pending.runDir, entry)) {
      entry.status = 'recovered-incomplete-evidence';
    }
    entry.stage = 'recovered';
    manifest.status = 'paused';
    manifest.stage = 'recovered';
    manifest.updatedAt = new Date().toISOString();
    if (manifest.error) {
      manifest.previousErrors = [...(manifest.previousErrors ?? []), manifest.error];
      delete manifest.error;
    }
    const temporary = `${manifestFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, manifestFile);
  } });
  console.log(result.resultSaved
    ? 'JPEG 파일 검증과 원본 복원을 완료했습니다. 다른 사진은 처리하지 않았습니다.'
    : '원본 상태를 확인했습니다. 저장된 편집 결과가 없어 이 사진은 완료로 처리하지 않았습니다.');
  console.log(`결과 폴더: ${pending.runDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recoverPhoto().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
