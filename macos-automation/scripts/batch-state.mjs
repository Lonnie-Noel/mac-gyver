import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJSON } from './bridge.mjs';

const terminalStatuses = new Set(['complete', 'skipped-existing-edits', 'skipped-video']);
export const batchPointerPath = artifacts => path.join(artifacts, 'input-batch.json');
export const isFinishedPhoto = record => terminalStatuses.has(record?.status);
export function remainingItems(plan, manifest) {
  return plan.items.filter(item => !isFinishedPhoto(manifest.photos[item.id]));
}

function requireMatchingInput(input, recorded) {
  const fields = ['path', 'filename', 'bytes', 'sha256'];
  if (input.directory !== recorded.directory || !Array.isArray(recorded.files) ||
      recorded.files.length !== input.files.length || input.files.some((file, index) =>
        fields.some(field => file[field] !== recorded.files[index]?.[field]))) {
    throw new Error('InputImages의 파일 목록이나 원본 바이트가 기존 작업과 달라졌습니다. 기존 파일로 돌려놓고 이어하거나, npm start -- --new-run으로 새 앨범을 만드세요. 기존 앨범과 결과는 보존했습니다.');
  }
}

// Only the pointer written before an import can identify the current batch.
// Never guess by album name, last modified folder, or the currently open photo.
export async function loadInputBatch(artifacts, input) {
  const pointerPath = batchPointerPath(artifacts);
  if (!existsSync(pointerPath)) return null;
  const pointer = await readJSON(pointerPath);
  const runDir = path.resolve(pointer.runDir ?? '');
  if (pointer.version !== 1 || typeof pointer.runID !== 'string' || !pointer.runID ||
      path.dirname(runDir) !== path.resolve(artifacts)) throw new Error('이어할 작업 폴더 기록이 유효하지 않습니다.');
  const manifest = await readJSON(path.join(runDir, 'manifest.json'));
  if (manifest.version !== 3 || manifest.source !== 'input-folder' || manifest.runID !== pointer.runID ||
      !manifest.photos || typeof manifest.photos !== 'object' || Array.isArray(manifest.photos)) {
    throw new Error('이어할 작업의 manifest가 유효하지 않습니다.');
  }
  const journal = await readJSON(path.join(runDir, 'import.json'));
  if (journal.runID !== pointer.runID) throw new Error('가져오기 기록의 작업 ID가 다릅니다.');
  requireMatchingInput(input, journal);
  const planPath = path.join(runDir, 'plan.json');
  if (!existsSync(planPath)) {
    throw new Error(`이전 일괄 가져오기의 완료 확인이 남아 있습니다. 중복 복사를 막기 위해 자동으로 다시 가져오지 않습니다. 기록: ${runDir}. 기존 앨범을 확인한 뒤 별도 작업이 필요하면 npm start -- --new-run을 사용하세요.`);
  }
  const plan = await readJSON(planPath);
  requireMatchingInput(input, plan);
  if (plan.version !== 3 || plan.source !== 'input-folder' || plan.runID !== pointer.runID ||
      !plan.album?.id || plan.album.id !== manifest.album?.id || plan.album.name !== journal.albumName ||
      !Array.isArray(plan.items) || plan.items.length !== input.files.length ||
      !Array.isArray(journal.imported) || journal.imported.length !== plan.items.length ||
      !Array.isArray(plan.originalIDs) || plan.originalIDs.length !== plan.items.length ||
      new Set(plan.originalIDs).size !== plan.items.length ||
      new Set(plan.items.map(item => item.id)).size !== plan.items.length ||
      plan.items.some((item, index) => {
        const receipt = journal.imported[index];
        return !item.id || typeof item.id !== 'string' || item.filename !== input.files[index].filename ||
          ![item.width, item.height].every(value => Number.isSafeInteger(value) && value > 0) ||
          !plan.originalIDs.includes(item.id) || receipt?.album?.id !== plan.album.id ||
          ['id', 'filename', 'width', 'height'].some(field => item[field] !== receipt?.item?.[field]) ||
          ['path', 'filename', 'bytes', 'sha256'].some(field => input.files[index][field] !== receipt?.source?.[field]);
      }) || Object.keys(manifest.photos).some(id => !plan.items.some(item => item.id === id))) {
    throw new Error('고정한 사진 ID·입력 파일·앨범 기록이 일치하지 않습니다. 사진을 가져오거나 편집하지 않습니다.');
  }
  for (const [id, result] of Object.entries(manifest.photos)) {
    const item = plan.items.find(item => item.id === id);
    if (result.item?.id !== id || result.item?.filename !== item.filename) throw new Error('완료 기록의 사진 식별자가 작업 계획과 다릅니다.');
  }
  return { runDir, manifest, plan };
}
