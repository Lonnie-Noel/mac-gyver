import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJSON } from './bridge.mjs';
import { rotateItems } from './core.mjs';

export const albumBatchPointerPath = (artifacts, id) => path.join(artifacts, `album-clone-${createHash('sha256').update(id).digest('hex')}.json`);

export async function resolveNamedAlbum(bridge, name) {
  const { albums } = await bridge.call('albums');
  if (!Array.isArray(albums)) throw new Error('앨범 목록 형식 오류');
  const matches = albums.filter(album => typeof album.name === 'string' && album.name.normalize('NFC') === name.normalize('NFC'));
  if (!matches.length) throw new Error(`사진 앱에 “${name}” 앨범이 없습니다. 앨범을 만들고 사진을 넣어 주세요.`);
  if (matches.length !== 1 || !matches[0].id) throw new Error(`“${name}” 이름의 앨범이 여러 개이거나 식별자가 없습니다. 앨범 이름을 고유하게 바꿔 주세요.`);
  return matches[0];
}

export async function namedAlbumPlan(bridge, album) {
  const contents = await bridge.call('albumItems', { id: album.id });
  if (contents.id !== album.id) throw new Error('요청과 다른 앨범입니다.');
  const items = rotateItems(contents.items, contents.items?.[0]?.id);
  return { version: 3, source: 'album-clone', createdAt: new Date().toISOString(), album,
    startingItemID: items[0].id, originalIDs: items.map(item => item.id), items };
}

export async function loadAlbumBatch(artifacts, album) {
  const pointerPath = albumBatchPointerPath(artifacts, album.id);
  if (!existsSync(pointerPath)) return null;
  const pointer = await readJSON(pointerPath), runDir = path.resolve(pointer.runDir ?? '');
  if (pointer.version !== 1 || !pointer.runID || path.dirname(runDir) !== path.resolve(artifacts)) throw new Error('앨범 작업 폴더 기록이 유효하지 않습니다.');
  const manifest = await readJSON(path.join(runDir, 'manifest.json'));
  if (!existsSync(path.join(runDir, 'plan.json'))) throw new Error('이전 앨범 복사의 완료 확인이 남아 있습니다. 사본을 자동으로 다시 만들지 않습니다. 기록: ' + runDir);
  const plan = await readJSON(path.join(runDir, 'plan.json'));
  if (manifest.version !== 3 || plan.version !== 3 || manifest.source !== 'album-clone' || plan.source !== 'album-clone' ||
      manifest.runID !== pointer.runID || plan.runID !== pointer.runID ||
      manifest.sourceAlbum?.id !== album.id || plan.sourceAlbum?.id !== album.id ||
      !plan.album?.id || plan.album.id === album.id || plan.album.id !== manifest.album?.id ||
      !manifest.photos || Array.isArray(manifest.photos) || typeof manifest.photos !== 'object') throw new Error('앨범 이어하기 기록이 일치하지 않습니다.');
  rotateItems(plan.items, plan.startingItemID);
  validateCloneResult({ album: plan.album, sourceAlbum: plan.sourceAlbum, sourceItems: plan.sourceItems, imports: plan.imports }, { album: plan.sourceAlbum, items: plan.sourceItems }, plan.album.name);
  if (JSON.stringify(plan.items) !== JSON.stringify(plan.imports.map(entry => entry.item))) throw new Error('사본 사진 목록과 복사 영수증이 다릅니다.');
  if (JSON.stringify(plan.originalIDs) !== JSON.stringify(plan.items.map(item => item.id))) throw new Error('앨범 사진 ID 기록이 일치하지 않습니다.');
  for (const [id, result] of Object.entries(manifest.photos)) {
    const item = plan.items.find(item => item.id === id);
    if (!item || result.item?.id !== id || result.item?.filename !== item.filename) throw new Error('앨범 완료 기록의 사진 식별자가 다릅니다.');
  }
  return { runDir, manifest, plan };
}


export function cloneAlbumName(date = new Date()) {
  const p = (value, width = 2) => String(value).padStart(width, '0');
  return `Reframe-${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
}

export function validateCloneResult(result, source, albumName) {
  const sourceIDs = new Set(source.items.map(item => item.id));
  const ids = new Set();
  if (!result?.album?.id || result.album.id === source.album.id || result.album.name !== albumName ||
      result.sourceAlbum?.id !== source.album.id || result.sourceAlbum.name !== 'Reframe' ||
      !Array.isArray(result.sourceItems) || result.sourceItems.length !== source.items.length ||
      !Array.isArray(result.imports) || result.imports.length !== source.items.length) throw new Error('앨범 사본 응답이 원본 계획과 다릅니다. 복사를 재전송하지 않습니다.');
  for (let index = 0; index < source.items.length; index++) {
    const original = source.items[index], receipt = result.sourceItems[index], copied = result.imports[index], item = copied?.item;
    if (receipt.id !== original.id || receipt.filename !== original.filename ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 ||
        !item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || sourceIDs.has(item.id) ||
        item.filename !== original.filename || copied.sourceSHA256 !== receipt.sha256 ||
        ![item.width, item.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('사진 사본의 독립된 ID·파일명·원본 해시가 일치하지 않습니다.');
    ids.add(item.id);
  }
  return result;
}
