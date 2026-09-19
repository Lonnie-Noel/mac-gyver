import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, TextDecoder } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const photosBundleId = 'com.apple.mobileslideshow';
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const imageExtension = /\.(?:heic|heif|jpe?g|png|tiff?|dng|gif|webp|avif)$/i;
// Keep extensionless camera names aligned with photo-filename.mjs.
const cameraStem = /^(?:IMG_E?\d{4,}(?:[_-][a-z0-9]+)*|DSC_\d{4,}(?:[_-][a-z0-9]+)*|PXL_\d{8}_\d{6,}(?:[._-][a-z0-9]+)*)$/iu;
const filenameKey = (value) => value.normalize('NFC').toLowerCase();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class ExportBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'ExportBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new ExportBridgeError(code, message, details); }
function assert(condition, message) { if (!condition) fail('PROTOCOL_INVALID', message); }
function safeName(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 230
    && value === value.trim() && !value.startsWith('.') && !value.endsWith('.')
    && !/[\x00-\x1f\x7f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function validateSourceName(filename, allowStem = false) {
  assert(safeName(filename) && (imageExtension.test(filename) || (allowStem && cameraStem.test(filename))),
    '사진 원래 파일명(확장자 포함) 또는 IMG_1234 같은 카메라 파일명이 필요합니다.');
}
function matchesSourceName(expected, actual) {
  validateSourceName(actual);
  return filenameKey(actual) === filenameKey(expected)
    || (cameraStem.test(expected) && filenameKey(path.parse(actual).name) === filenameKey(expected));
}
function decodeBase64(value, maxBytes, description) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maxBytes / 3) * 4
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  `${description}: 잘못되었거나 너무 큰 Base64 응답입니다.`);
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.length <= maxBytes && bytes.toString('base64') === value, `${description}: Base64가 일치하지 않습니다.`);
  return bytes;
}
function assertJPEG(bytes) {
  assert(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, '결과 파일이 완전한 JPEG 형식이 아닙니다.');
}
function dimensions(value) {
  return Number.isSafeInteger(value?.width) && Number.isSafeInteger(value?.height)
    && value.width > 0 && value.height > 0 && value.width <= 200_000 && value.height <= 200_000;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Treat these as Gregorian calendar fields, never as a Date in the Mac's time
// zone. They come from the iPhone's displayed local date, at minute precision.
function canonicalSelection(value) {
  assert(exactKeys(value, ['creationLocal', 'width', 'height']) && dimensions(value),
    '사진 선택 정보에는 creationLocal과 유효한 width·height가 모두 필요합니다.');
  const date = value.creationLocal;
  assert(exactKeys(date, ['year', 'month', 'day', 'hour', 'minute'])
    && Object.values(date).every(Number.isSafeInteger)
    && date.year >= 1 && date.year <= 9999 && date.month >= 1 && date.month <= 12
    && date.day >= 1 && date.day <= 31 && date.hour >= 0 && date.hour <= 23
    && date.minute >= 0 && date.minute <= 59,
  '사진의 현지 촬영 시각은 유효한 연·월·일·시·분 정수여야 합니다.');
  const checked = new Date(0);
  checked.setUTCFullYear(date.year, date.month - 1, date.day);
  checked.setUTCHours(date.hour, date.minute, 0, 0);
  assert(checked.getUTCFullYear() === date.year && checked.getUTCMonth() + 1 === date.month
    && checked.getUTCDate() === date.day, '존재하지 않는 촬영 날짜입니다.');
  return { creationLocal: { year: date.year, month: date.month, day: date.day,
    hour: date.hour, minute: date.minute }, width: value.width, height: value.height };
}

function validAssetId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\x00-\x1f]/.test(value);
}

// Decode the full JPEG to PNG at its original dimensions. A header-only query or
// tiny resample could accept corrupt pixels or use an embedded preview instead.
export async function validateJPEGWithSips(filename) {
  const { stdout } = await execFileAsync('/usr/bin/sips', ['-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', filename],
    { timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert(/^\s*format:\s*jpeg\s*$/m.test(stdout), 'macOS에서 결과 파일을 JPEG로 읽지 못했습니다.');
  const result = {
    width: Number(stdout.match(/^\s*pixelWidth:\s*(\d+)\s*$/m)?.[1]),
    height: Number(stdout.match(/^\s*pixelHeight:\s*(\d+)\s*$/m)?.[1]),
  };
  assert(dimensions(result), '결과 JPEG의 전체 이미지 크기를 확인하지 못했습니다.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'photos-jpeg-check-'));
  try {
    const decoded = path.join(temp, 'decoded.png');
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', filename, '--out', decoded],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const handle = await open(decoded, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assert(stat.isFile() && stat.size >= 45, 'JPEG 전체 픽셀을 PNG로 해독하지 못했습니다.');
      const header = Buffer.alloc(24);
      const trailer = Buffer.alloc(12);
      await handle.read(header, 0, 24, 0);
      await handle.read(trailer, 0, 12, stat.size - 12);
      assert(header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        && header.readUInt32BE(8) === 13 && header.toString('ascii', 12, 16) === 'IHDR'
        && header.readUInt32BE(16) === result.width && header.readUInt32BE(20) === result.height
        && trailer.equals(Buffer.from('0000000049454e44ae426082', 'hex')),
      'JPEG를 원래 전체 크기의 완전한 PNG로 해독하지 못했습니다.');
    } finally { await handle.close(); }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return result;
}

function missingRemoteFile(error, remotePath) {
  const message = String(error?.message ?? '');
  return /\b(?:AFC_E_)?OBJECT_NOT_FOUND\b/.test(message)
    || (message.includes(remotePath) && /(?:remote file|file at).*(?:does not exist|No such file)/i.test(message));
}

/** Offline validation; never sends a device command or alters a file. */
export async function verifyExportReceipt(runDir, receipt, { validateImage = validateJPEGWithSips } = {}) {
  const requestedRoot = path.resolve(runDir);
  const rootStat = await lstat(requestedRoot);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), '실행 결과 폴더는 실제 디렉터리여야 합니다.');
  const root = await realpath(requestedRoot);
  assert(receipt && receipt.action === 'export' && uuidPattern.test(receipt.requestId ?? '')
    && receipt.id === receipt.requestId && receipt.outputFile === `${receipt.requestId}-result.jpg`
    && safeName(receipt.relativePath) && receipt.relativePath.endsWith('-result.jpg')
    && receipt.filename === receipt.relativePath && shaPattern.test(receipt.sha256 ?? '')
    && shaPattern.test(receipt.originalSHA256 ?? '') && shaPattern.test(receipt.currentSHA256 ?? '')
    && typeof receipt.assetId === 'string' && receipt.assetId.length > 0 && receipt.hasAdjustments === true
    && Number.isSafeInteger(receipt.byteLength) && receipt.byteLength > 0 && dimensions(receipt),
  '검증할 내보내기 기록이 올바르지 않습니다.');
  validateSourceName(receipt.originalFilename);
  const target = path.join(root, receipt.relativePath);
  assert(receipt.localPath === target && receipt.path === target, '다른 실행 폴더의 내보내기 기록입니다.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size === receipt.byteLength, '내보낸 JPEG 크기가 변경되었습니다.');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  assertJPEG(bytes);
  assert(digest(bytes) === receipt.sha256, 'Mac에 저장한 JPEG가 변경되었습니다. 원복하지 않습니다.');
  const decoded = await validateImage(target);
  assert(dimensions(decoded) && decoded.width === receipt.width && decoded.height === receipt.height,
    'Mac에 저장한 JPEG를 원래 크기로 읽지 못했습니다. 원복하지 않습니다.');
  return { ...receipt, verifiedAt: new Date().toISOString() };
}

/**
 * PhotoKit helper IPC. mobileCall(session, command, args) matches phone.mobile.
 * The helper must already be installed, signed, and granted full Photos access.
 * Creating the bridge does not contact an iPhone; only inspect/exportResult/revert do.
 */
export function createExportBridge({ session, bundleId, runDir, mobileCall, timeoutMs = 180_000,
  pollMs = 1000, validateImage = validateJPEGWithSips } = {}) {
  assert(typeof session === 'string' && session.length > 0, 'Appium 세션이 필요합니다.');
  assert(typeof bundleId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(bundleId)
    && bundleId !== photosBundleId, '내보내기 도우미의 Bundle ID가 필요합니다.');
  assert(typeof runDir === 'string' && runDir.length > 0, '실행 결과 폴더가 필요합니다.');
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 180_000,
    '도우미 제한 시간은 1~180000ms여야 합니다.');
  assert(Number.isFinite(pollMs) && pollMs >= 1 && pollMs <= 5000, '폴링 간격은 1~5000ms여야 합니다.');
  assert(typeof validateImage === 'function' && (mobileCall === undefined || typeof mobileCall === 'function'),
    '잘못된 브리지 함수 설정입니다.');
  let root;
  let busy = false;
  const requestedRoot = path.resolve(runDir);

  async function directories() {
    await mkdir(requestedRoot, { recursive: true });
    const rootStat = await lstat(requestedRoot);
    assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), '실행 결과 폴더는 실제 디렉터리여야 합니다.');
    const currentRoot = await realpath(requestedRoot);
    if (root && root !== currentRoot) fail('PATH_CHANGED', '실행 결과 폴더의 경로가 변경되었습니다.');
    root = currentRoot;
    const metadata = path.join(root, '.metadata');
    await mkdir(metadata, { recursive: true });
    const metadataStat = await lstat(metadata);
    assert(metadataStat.isDirectory() && !metadataStat.isSymbolicLink()
      && await realpath(metadata) === metadata, '메타데이터 폴더가 실행 폴더 밖을 가리킵니다.');
    return metadata;
  }

  async function atomicExclusive(filename, bytes) {
    const metadata = await directories();
    const target = path.resolve(root, filename);
    assert(path.dirname(target) === root || path.dirname(target) === metadata, '허용하지 않는 로컬 파일 경로입니다.');
    const temp = path.join(metadata, `.pending-${randomUUID()}`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      await directories();
      await link(temp, target); // Atomic no-replace publish; rename() could overwrite an earlier result.
      const directory = await open(path.dirname(target), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error.code === 'EEXIST') fail('OUTPUT_EXISTS', `기존 파일을 덮어쓰지 않습니다: ${filename}`, { cause: error });
      throw error;
    } finally { await unlink(temp).catch(() => {}); }
    return target;
  }

  async function call(command, args, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('BRIDGE_TIMEOUT', '도우미 응답 제한 시간이 지났습니다. 사진 상태를 확인하기 전 재시도하지 마세요.');
    let timer;
    try {
      const operation = mobileCall ? mobileCall(session, command, args) : (async () => {
        const response = await fetch(`http://127.0.0.1:4723/session/${encodeURIComponent(session)}/execute/sync`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: `mobile: ${command}`, args: [args] }), signal: AbortSignal.timeout(remaining),
        });
        const body = await response.json();
        if (!response.ok || body.value?.error) throw new Error(JSON.stringify(body.value));
        return body.value;
      })();
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ExportBridgeError('BRIDGE_TIMEOUT',
          '도우미 응답 제한 시간이 지났습니다. 작업이 진행 중일 수 있으므로 자동 재시도하지 않습니다.')), remaining);
      })]);
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        fail('BRIDGE_TIMEOUT', '도우미 요청 제한 시간이 지났습니다. 사진 상태를 확인하기 전 재시도하지 마세요.', { cause: error });
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function poll(remotePath, deadline) {
    while (Date.now() < deadline) {
      try { return await call('pullFile', { remotePath }, deadline); }
      catch (error) {
        if (!missingRemoteFile(error, remotePath)) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
    fail('BRIDGE_TIMEOUT', '도우미가 제한 시간 안에 응답 파일을 만들지 못했습니다.');
  }

  function identity(response, request, baseline) {
    assert(response && typeof response === 'object' && !Array.isArray(response), '도우미 응답은 JSON 객체여야 합니다.');
    assert(response.id === request.id, '다른 요청의 도우미 응답입니다.');
    assert(typeof response.ok === 'boolean', '도우미 응답에 성공 여부가 없습니다.');
    if (!response.ok) {
      const detail = typeof response.error === 'string' ? response.error : response.error?.message;
      const helperCode = typeof response.error === 'object' ? response.error?.code : undefined;
      fail('HELPER_REJECTED', `사진 내보내기 도우미가 중단했습니다: ${detail || '사유 없음'}`,
        { helperCode, requestId: request.id, action: request.action });
    }
    assert(validAssetId(response.assetId), '도우미가 안정적인 사진 ID를 반환하지 않았습니다.');
    validateSourceName(response.originalFilename);
    assert(shaPattern.test(response.originalSHA256 ?? '') && shaPattern.test(response.currentSHA256 ?? ''),
      '원본 및 현재 이미지 SHA-256이 없거나 잘못되었습니다.');
    assert(typeof response.hasAdjustments === 'boolean', '사진의 기존 편집 여부가 없습니다.');
    if (baseline) {
      assert(response.assetId === baseline.assetId && response.originalFilename === baseline.originalFilename
        && response.originalSHA256 === baseline.originalSHA256, '처음 확인한 사진 ID·파일명·원본 해시와 일치하지 않습니다.');
    } else {
      assert(matchesSourceName(request.filename, response.originalFilename), '요청한 원래 파일명과 다른 사진입니다.');
    }
  }

  function baselinePayload(baseline) {
    assert(baseline && typeof baseline.assetId === 'string' && baseline.assetId.length > 0
      && shaPattern.test(baseline.originalSHA256 ?? '') && shaPattern.test(baseline.currentSHA256 ?? ''),
    '검증된 사진 기준 정보가 필요합니다.');
    validateSourceName(baseline.originalFilename);
    assert(baseline.hasAdjustments === false, '이전에 편집된 사진은 자동으로 내보내거나 원복하지 않습니다.');
    return { assetId: baseline.assetId, expectedOriginalFilename: baseline.originalFilename,
      baselineOriginalSHA256: baseline.originalSHA256 };
  }

  async function transaction(action, fields, processResponse) {
    if (busy) fail('BRIDGE_BUSY', '사진 내보내기 도우미 작업이 이미 진행 중입니다.');
    busy = true;
    const request = { id: randomUUID(), action, ...fields };
    const record = { request, startedAt: new Date().toISOString() };
    const receiptFile = `.metadata/${action}-${request.id}.json`;
    let result;
    let failure;
    let contacted = false;
    let receiptPath;
    try {
      await directories();
      const deadline = Date.now() + timeoutMs;
      const remote = (filename) => `@${bundleId}:documents/${filename}`;
      contacted = true;
      await call('pushFile', { remotePath: remote('request.json'), payload: Buffer.from(JSON.stringify(request)).toString('base64') }, deadline);
      await call('activateApp', { bundleId }, deadline);
      const encoded = await poll(remote(`${request.id}-response.json`), deadline);
      const bytes = decodeBase64(encoded, 1024 * 1024, '도우미 JSON');
      try { record.response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch (error) { fail('PROTOCOL_INVALID', '도우미 JSON 응답을 읽을 수 없습니다.', { cause: error }); }
      result = await processResponse(record.response, request, { remote, deadline });
      record.result = result;
      record.ok = true;
      record.finishedAt = new Date().toISOString();
      // Publish the recovery receipt before switching apps or returning to the
      // caller's journal, so a crash there cannot lose an already verified JPEG.
      receiptPath = await atomicExclusive(receiptFile, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
      Object.assign(result, { receiptFile, receiptPath });
    } catch (error) {
      failure = error;
      record.ok = false;
      record.error = { code: error.code || 'BRIDGE_FAILED', message: error.message };
    } finally {
      if (contacted) {
        try {
          const restoreDeadline = Date.now() + Math.min(timeoutMs, 30_000);
          await call('activateApp', { bundleId: photosBundleId }, restoreDeadline);
          // activateApp can return while the helper is still in the foreground.
          // Do not hand control back to the photo workflow until Photos is active.
          while (true) {
            const active = await call('activeAppInfo', {}, restoreDeadline);
            if (active?.bundleId === photosBundleId) break;
            if (active?.bundleId !== bundleId && active?.bundleId !== 'com.apple.springboard') {
              fail('PHOTOS_NOT_FOREGROUND', '사진 앱 복귀 중 예상하지 못한 앱이 전면에 있습니다.');
            }
            const remaining = restoreDeadline - Date.now();
            if (remaining <= 0) fail('BRIDGE_TIMEOUT', '제한 시간 안에 사진 앱이 전면으로 돌아오지 않았습니다.');
            await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
          }
        }
        catch (error) {
          record.photosRestoreError = error.message;
          if (!failure) failure = new ExportBridgeError('PHOTOS_REACTIVATE_FAILED',
            '사진 앱으로 돌아오지 못했습니다. 다음 사진으로 이동하지 마세요.', { cause: error });
        }
      }
      try {
        if (!receiptPath) {
          record.finishedAt = new Date().toISOString();
          receiptPath = await atomicExclusive(receiptFile, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
        }
        if (result) Object.assign(result, { receiptFile, receiptPath });
        if (failure) Object.assign(failure, { receiptFile, receiptPath });
      } catch (error) {
        if (failure) failure.receiptError = error.message;
        else failure = error;
      }
      busy = false;
    }
    if (failure) throw failure;
    return result;
  }

  async function inspect(filename, { preserveBaseline = false, selection, assetId, baselineOriginalSHA256 } = {}) {
    validateSourceName(filename, true);
    assert(typeof preserveBaseline === 'boolean', '기준 정보 보존 옵션은 true 또는 false여야 합니다.');
    const fields = { filename, ...(preserveBaseline ? { preserveBaseline: true } : {}) };
    if (selection !== undefined) fields.selection = canonicalSelection(selection);
    if (assetId !== undefined || baselineOriginalSHA256 !== undefined) {
      assert(preserveBaseline && validAssetId(assetId) && typeof baselineOriginalSHA256 === 'string'
        && shaPattern.test(baselineOriginalSHA256),
        '정확한 사진 복구에는 preserveBaseline:true와 사진 ID·초기 원본 SHA-256이 함께 필요합니다.');
      Object.assign(fields, { assetId, baselineOriginalSHA256 });
    }
    return transaction('inspect', fields, async (response, request) => {
      identity(response, request);
      let responseSelection;
      if (request.selection !== undefined) {
        responseSelection = canonicalSelection(response.selection);
        assert(JSON.stringify(responseSelection) === JSON.stringify(request.selection),
          '도우미가 확인한 촬영 시각·이미지 크기가 현재 사진 선택 정보와 다릅니다.');
      }
      if (request.assetId !== undefined) {
        assert(response.assetId === request.assetId && response.originalSHA256 === request.baselineOriginalSHA256,
          '복구 요청의 사진 ID·초기 원본 해시와 도우미 응답이 일치하지 않습니다.');
      }
      return { ...response, ...(responseSelection ? { selection: responseSelection } : {}),
        requestId: request.id, action: 'inspect' };
    });
  }

  async function exportResult(baseline, outputBase) {
    const fields = baselinePayload(baseline);
    assert(safeName(outputBase) && Buffer.byteLength(outputBase) <= 200, '안전한 결과 파일명이 필요합니다.');
    const filename = `${outputBase}-result.jpg`;
    await directories();
    try {
      await lstat(path.join(root, filename));
      fail('OUTPUT_EXISTS', `기존 파일을 덮어쓰지 않습니다: ${filename}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return transaction('export', fields, async (response, request, { remote, deadline }) => {
      identity(response, request, baseline);
      assert(response.hasAdjustments === true, '적용된 리프레임 편집 결과를 확인하지 못했습니다.');
      assert(response.outputFile === `${request.id}-result.jpg`, '도우미가 요청과 다른 JPEG 경로를 반환했습니다.');
      assert(shaPattern.test(response.sha256 ?? '') && dimensions(response), 'JPEG 해시·전체 이미지 크기가 올바르지 않습니다.');
      const bytes = decodeBase64(await poll(remote(response.outputFile), deadline), 512 * 1024 * 1024, '결과 JPEG');
      assertJPEG(bytes);
      assert(response.bytes === undefined || response.bytes === bytes.length, '전송된 JPEG 바이트 수가 도우미 결과와 다릅니다.');
      assert(digest(bytes) === response.sha256, '전송된 JPEG의 SHA-256이 도우미 결과와 다릅니다.');
      const metadata = await directories();
      const validationFile = path.join(metadata, `.jpeg-${request.id}.jpg`);
      let checked;
      try {
        await atomicExclusive(path.relative(root, validationFile), bytes);
        checked = await validateImage(validationFile);
        assert(dimensions(checked) && checked.width === response.width && checked.height === response.height,
          'Mac에서 읽은 JPEG 전체 크기가 도우미 결과와 다릅니다.');
      } finally { await unlink(validationFile).catch(() => {}); }
      const localPath = await atomicExclusive(filename, bytes);
      return { ...response, requestId: request.id, action: 'export', filename, relativePath: filename,
        localPath, path: localPath, byteLength: bytes.length, verifiedAt: new Date().toISOString() };
    });
  }

  async function verifyLocalExport(receipt) {
    await directories();
    return verifyExportReceipt(root, receipt, { validateImage });
  }

  async function findVerifiedExport(baseline, outputBase) {
    baselinePayload(baseline);
    assert(safeName(outputBase) && Buffer.byteLength(outputBase) <= 200, '안전한 결과 파일명이 필요합니다.');
    const filename = `${outputBase}-result.jpg`;
    const metadata = await directories();
    const matches = [];
    for (const entry of await readdir(metadata, { withFileTypes: true })) {
      if (!/^export-[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), '내보내기 기록은 일반 파일이어야 합니다.');
      const receiptFile = `.metadata/${entry.name}`;
      const receiptPath = path.join(root, receiptFile);
      const handle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let record;
      try {
        assert((await handle.stat()).size <= 2 * 1024 * 1024, '내보내기 기록이 너무 큽니다.');
        record = JSON.parse(await handle.readFile('utf8'));
      } catch (error) { fail('RECOVERY_RECORD_INVALID', `내보내기 기록을 읽지 못했습니다: ${entry.name}`, { cause: error }); }
      finally { await handle.close(); }
      assert(record?.request?.action === 'export' && uuidPattern.test(record.request.id ?? '')
        && entry.name === `export-${record.request.id}.json`, '요청 ID가 다른 내보내기 기록입니다.');
      if (!record.ok || !record.result) continue;
      const candidate = record.result;
      if (candidate.relativePath !== filename) continue;
      identity(record.response, record.request, baseline);
      assert(candidate.relativePath === filename && candidate.assetId === baseline.assetId
        && candidate.originalFilename === baseline.originalFilename && candidate.originalSHA256 === baseline.originalSHA256
        && candidate.id === record.request.id && record.response?.id === record.request.id
        && record.request.assetId === baseline.assetId
        && record.request.expectedOriginalFilename === baseline.originalFilename
        && record.request.baselineOriginalSHA256 === baseline.originalSHA256
        && record.response.sha256 === candidate.sha256 && record.response.outputFile === candidate.outputFile
        && record.response.currentSHA256 === candidate.currentSHA256
        && record.response.width === candidate.width && record.response.height === candidate.height,
      '같은 사진 또는 파일명의 내보내기 기록이 현재 기준과 다릅니다.');
      matches.push({ ...candidate, receiptFile, receiptPath });
    }
    if (matches.length > 1) fail('RECOVERY_AMBIGUOUS', '동일 사진에 여러 내보내기 기록이 있어 자동으로 선택하지 않습니다.');
    return matches.length ? verifyLocalExport(matches[0]) : null;
  }

  async function revert(baseline, exportReceipt) {
    const fields = baselinePayload(baseline);
    const verified = await verifyLocalExport(exportReceipt);
    assert(verified.assetId === baseline.assetId && verified.originalFilename === baseline.originalFilename
      && verified.originalSHA256 === baseline.originalSHA256, '내보내기 기록과 원복할 원본 사진이 다릅니다.');
    return transaction('revert', { ...fields, verifiedExportSHA256: verified.sha256 }, async (response, request) => {
      identity(response, request, baseline);
      assert(response.restored === true && response.hasAdjustments === false, '사진의 원복 완료를 확인하지 못했습니다.');
      return { ...response, requestId: request.id, action: 'revert', verifiedExportSHA256: verified.sha256 };
    });
  }

  return { inspect, exportResult, verifyLocalExport, findVerifiedExport, revert };
}
