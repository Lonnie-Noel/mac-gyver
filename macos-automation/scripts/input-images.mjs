import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readUI } from './core.mjs';

const imageExtension = /\.(jpe?g|png|heic|heif|tiff?)$/i;
const maximumBytes = 512 * 1024 * 1024;

// Freeze a list and content hashes before touching Photos. Native import reads
// the bytes again and verifies these hashes before creating any library asset.
export async function scanInputImages(directory, { limit } = {}) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit은 양의 정수여야 합니다.');
  const absolute = path.resolve(directory);
  let info;
  try { info = await lstat(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`InputImages 폴더를 만들고 이미지를 넣어 주세요: ${absolute}`);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('InputImages는 심볼릭 링크가 아닌 실제 폴더여야 합니다.');
  const resolved = await realpath(absolute);
  const names = (await readdir(resolved)).sort();
  const files = [], ignored = [];
  for (const filename of names) {
    if (filename.startsWith('.') || !imageExtension.test(filename)) { ignored.push(filename); continue; }
    const source = path.join(resolved, filename), entry = await lstat(source);
    if (entry.isSymbolicLink()) throw new Error(`이미지 심볼릭 링크는 지원하지 않습니다: ${filename}`);
    if (entry.isDirectory()) { ignored.push(filename); continue; }
    if (!entry.isFile() || entry.size < 1 || entry.size > maximumBytes) throw new Error(`이미지는 0바이트보다 크고 512MB 이하인 일반 파일이어야 합니다: ${filename}`);
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== entry.size || before.ino !== entry.ino || before.dev !== entry.dev) throw new Error(`검사 중 입력 파일이 바뀌었습니다: ${filename}`);
      const hash = createHash('sha256');
      let bytesRead = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytesRead += chunk.length;
        if (bytesRead > before.size) throw new Error(`검사 중 입력 파일이 커졌습니다: ${filename}`);
        hash.update(chunk);
      }
      const after = await handle.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`검사 중 입력 파일이 바뀌었습니다: ${filename}`);
      files.push({ path: source, filename, bytes: before.size, sha256: hash.digest('hex') });
    } finally { await handle.close(); }
  }
  if (!files.length) throw new Error(`InputImages에 지원 이미지가 없습니다. JPG, PNG, HEIC, HEIF, TIFF를 넣어 주세요: ${resolved}`);
  return { directory: resolved, files: limit === undefined ? files : files.slice(0, limit), ignored };
}

export async function requireImportReady(bridge) {
  await bridge.call('activate');
  const snapshot = await bridge.call('snapshot'), state = readUI(snapshot);
  if (state.editing || state.modal || state.alert || state.busy || snapshot.nodes.some(n => n.identifier === 'IPXToolbarItemIDToggleDoneEdit')) {
    throw new Error('사진 앱의 편집·대화상자를 먼저 닫고 일반 보기 화면에서 시작하세요. 앨범이나 사진 선택은 필요 없습니다.');
  }
}

export async function importInputImages(bridge, files, { runID, albumName, onImported = async () => {}, stopped = () => false }) {
  if (!Array.isArray(files) || !files.length) throw new Error('가져올 이미지 목록이 없습니다.');
  let album;
  const items = [], ids = new Set();
  for (const source of files) {
    if (stopped()) throw new Error('가져오기를 중지했습니다.');
    const result = await bridge.call('importImage', { runID, albumName, ...source });
    const item = result?.item, returnedAlbum = result?.album;
    if (!returnedAlbum || typeof returnedAlbum.id !== 'string' || !returnedAlbum.id || returnedAlbum.name !== albumName ||
        (album && returnedAlbum.id !== album.id) || !item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        item.filename !== source.filename || result.sourceSHA256 !== source.sha256 ||
        ![item.width, item.height].every(v => Number.isSafeInteger(v) && v > 0)) {
      throw new Error(`가져온 사진의 식별자·파일명·해시·앨범 검증에 실패했습니다: ${source.filename}. 가져오기 기록을 보존합니다.`);
    }
    album = returnedAlbum;
    ids.add(item.id); items.push(item);
    // A failed write stops here; never import the next file without a receipt.
    await onImported({ source, album, item });
  }
  return { source: 'input-folder', album, items };
}

export function verifyImportedAlbum(contents, album, items) {
  const expected = new Set(items.map(item => item.id));
  if (contents?.id !== album.id || !Array.isArray(contents.items) || contents.items.length !== items.length ||
      new Set(contents.items.map(item => item.id)).size !== expected.size ||
      contents.items.some(item => !expected.has(item.id))) {
    throw new Error('사진 앱에서 가져온 작업 앨범을 확인하지 못했습니다. 시스템 사진 보관함이 열려 있는지 확인하세요. 복사본은 남겨 두며 사진을 편집하지 않습니다.');
  }
  return contents.items.map(item => item.id);
}

// PhotoKit's transaction can finish before Photos.app observes the new album.
// Retry only reads; an import is never repeated to resolve this visibility lag.
export async function waitForImportedAlbum(bridge, album, items, {
  stopped = () => false, timeoutMs = 10_000, pollIntervalMs = 500,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (true) {
    if (stopped()) throw new Error('작업 앨범 확인 중 중지했습니다.');
    let contents;
    try { contents = await bridge.call('albumItems', { id: album.id }); }
    catch (error) {
      if (!error.message.includes('요청한 앨범 ID를 찾을 수 없습니다')) throw error;
      lastError = error;
    }
    if (contents) {
      try { return verifyImportedAlbum(contents, album, items); }
      catch (error) { lastError = error; }
    }
    if (now() >= deadline) throw new Error(`가져온 작업 앨범의 사진 ID 확인 시간이 초과되었습니다. 시스템 사진 보관함을 열었는지 확인하세요. ${lastError?.message ?? ''}`);
    await sleep(pollIntervalMs);
  }
}
