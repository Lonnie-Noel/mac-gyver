import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createExportBridge, ExportBridgeError, validateJPEGWithSips, verifyExportReceipt } from '../scripts/export-bridge.mjs';

const execFileAsync = promisify(execFile);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
const sha256 = createHash('sha256').update(jpeg).digest('hex');
const originalSHA256 = 'a'.repeat(64);
const initialCurrentSHA256 = 'b'.repeat(64);
const renderedCurrentSHA256 = 'c'.repeat(64);
const imageDimensions = { width: 4032, height: 3024 };

async function fixture(t, options = {}) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'photos-export-test-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const calls = [];
  const requests = [];
  let current;
  let responsePulls = 0;
  const mobileCall = async (session, command, args) => {
    assert.equal(session, 'test-session');
    calls.push({ command, args });
    if (command === 'pushFile') {
      assert.equal(args.remotePath, '@test.photos.helper:documents/request.json');
      current = JSON.parse(Buffer.from(args.payload, 'base64').toString('utf8'));
      requests.push(current);
      return null;
    }
    if (command === 'activateApp') {
      if (args.bundleId === 'com.apple.mobileslideshow') await options.onPhotosActivate?.(current, folder);
      else assert.equal(args.bundleId, 'test.photos.helper');
      return null;
    }
    assert.equal(command, 'pullFile');
    if (args.remotePath.endsWith('-response.json')) {
      responsePulls++;
      if (options.responsePull) await options.responsePull(current, responsePulls);
      let response = {
        id: current.id, ok: true, assetId: 'test-asset/L0/001', originalFilename: 'IMG_1234.HEIC',
        originalSHA256, currentSHA256: initialCurrentSHA256, hasAdjustments: false,
      };
      if (current.action === 'export') Object.assign(response, {
        currentSHA256: renderedCurrentSHA256, hasAdjustments: true,
        outputFile: `${current.id}-result.jpg`, sha256, ...imageDimensions,
      });
      if (current.action === 'revert') response.restored = true;
      response = await options.response?.(current, response) ?? response;
      return Buffer.from(JSON.stringify(response)).toString('base64');
    }
    assert.equal(args.remotePath, `@test.photos.helper:documents/${current.id}-result.jpg`);
    return (options.jpeg ?? jpeg).toString('base64');
  };
  const bridge = createExportBridge({
    session: 'test-session', bundleId: 'test.photos.helper', runDir: folder,
    timeoutMs: options.timeoutMs ?? 1000, pollMs: 1, mobileCall,
    validateImage: options.validateImage ?? (async () => imageDimensions),
  });
  return { folder, bridge, calls, requests };
}

function returnedToPhotos(calls) {
  assert.deepEqual(calls.at(-1), { command: 'activateApp', args: { bundleId: 'com.apple.mobileslideshow' } });
}

test('inspect resolves original filename; export saves original-name JPEG and immediate durable receipt; revert binds verified SHA', async (t) => {
  const setup = await fixture(t, { onPhotosActivate: async (request, folder) => {
    if (request.action !== 'export') return;
    const receipt = JSON.parse(await readFile(path.join(folder, '.metadata', `export-${request.id}.json`), 'utf8'));
    assert.equal(receipt.ok, true);
    assert.equal(receipt.result.sha256, sha256);
    assert.deepEqual(await readFile(path.join(folder, 'IMG_1234-result.jpg')), jpeg);
  } });
  const baseline = await setup.bridge.inspect('IMG_1234');
  assert.equal(baseline.originalFilename, 'IMG_1234.HEIC');
  assert.notEqual(baseline.originalSHA256, baseline.currentSHA256);
  const receipt = await setup.bridge.exportResult(baseline, 'IMG_1234');
  assert.equal(receipt.relativePath, 'IMG_1234-result.jpg');
  assert.equal(receipt.localPath, path.join(setup.folder, receipt.filename));
  assert.equal(receipt.width, 4032);
  assert.equal((await setup.bridge.verifyLocalExport(receipt)).sha256, sha256);
  assert.equal((await verifyExportReceipt(setup.folder, receipt, { validateImage: async () => imageDimensions })).sha256, sha256);
  const restored = await setup.bridge.revert(baseline, receipt);
  assert.equal(restored.restored, true);
  assert.equal(restored.hasAdjustments, false);
  assert.equal(restored.currentSHA256, initialCurrentSHA256);
  assert.equal(setup.requests.at(-1).verifiedExportSHA256, sha256);
  assert.equal(setup.requests.at(-1).baselineOriginalSHA256, originalSHA256);
  assert.equal(setup.requests.at(-1).expectedOriginalFilename, baseline.originalFilename);
  returnedToPhotos(setup.calls);
});

test('full original filename is accepted but arbitrary extensionless titles and paths are rejected before any phone call', async (t) => {
  const { bridge, calls } = await fixture(t);
  for (const value of ['Vacation', '../IMG_1234.HEIC', '/IMG_1234.HEIC', 'bad\\IMG_1234.JPG', 'IMG_1234\n.JPG']) {
    await assert.rejects(bridge.inspect(value), { code: 'PROTOCOL_INVALID' });
  }
  assert.equal(calls.length, 0);
  assert.equal((await bridge.inspect('IMG_1234.HEIC')).originalFilename, 'IMG_1234.HEIC');
});

test('recovery inspect explicitly preserves helper baseline and rejects non-boolean options', async (t) => {
  const { bridge, requests } = await fixture(t);
  await bridge.inspect('IMG_1234', { preserveBaseline: true });
  assert.equal(requests[0].preserveBaseline, true);
  await bridge.inspect('IMG_1234');
  assert.equal('preserveBaseline' in requests[1], false);
  await assert.rejects(bridge.inspect('IMG_1234', { preserveBaseline: 'true' }), { code: 'PROTOCOL_INVALID' });
  assert.equal(requests.length, 2);
});

test('camera suffix stems and NFC/case-normalized source filenames match the helper', async (t) => {
  for (const name of ['IMG_E1234', 'IMG_1234_editedsuffix', 'DSC_1234', 'PXL_20240101_123456789.MP']) {
    const { bridge } = await fixture(t, { response: (_, response) => ({ ...response, originalFilename: `${name}.HEIC` }) });
    assert.equal((await bridge.inspect(name.toLowerCase())).originalFilename, `${name}.HEIC`);
  }
  const { bridge } = await fixture(t, { response: (_, response) => ({ ...response, originalFilename: 'Café.HEIC' }) });
  assert.equal((await bridge.inspect('cafe\u0301.heic')).originalFilename, 'Café.HEIC');
});

test('wrong request ID and wrong source name fail without using stale helper responses', async (t) => {
  for (const change of [{ id: 'old-request-id' }, { originalFilename: 'IMG_9999.HEIC' }]) {
    const { bridge, calls } = await fixture(t, { response: (_, response) => ({ ...response, ...change }) });
    await assert.rejects(bridge.inspect('IMG_1234'), { code: 'PROTOCOL_INVALID' });
    returnedToPhotos(calls);
  }
});

test('ambiguous helper matches have a typed error and persist their response evidence', async (t) => {
  const { bridge, calls } = await fixture(t, { response: (request) => ({
    id: request.id, ok: false, error: { code: 'AMBIGUOUS_FILENAME', message: '동일 이름 사진 2개' },
  }) });
  let failure;
  try { await bridge.inspect('IMG_1234'); } catch (error) { failure = error; }
  assert.ok(failure instanceof ExportBridgeError);
  assert.equal(failure.code, 'HELPER_REJECTED');
  assert.equal(failure.helperCode, 'AMBIGUOUS_FILENAME');
  const record = JSON.parse(await readFile(failure.receiptPath, 'utf8'));
  assert.equal(record.response.error.code, 'AMBIGUOUS_FILENAME');
  assert.equal(record.ok, false);
  returnedToPhotos(calls);
});

test('only known remote missing-file errors are retried', async (t) => {
  let count = 0;
  const { bridge } = await fixture(t, { responsePull: () => {
    if (count++ === 0) throw new Error('AFC_E_OBJECT_NOT_FOUND');
  } });
  await bridge.inspect('IMG_1234');
  assert.equal(count, 2);
  count = 0;
  const broken = await fixture(t, { responsePull: () => { count++; throw new Error('invalid session id'); } });
  await assert.rejects(broken.bridge.inspect('IMG_1234'), /invalid session id/);
  assert.equal(count, 1);
  returnedToPhotos(broken.calls);
});

test('missing response expires at deadline and returns to Photos without retrying the mutation', async (t) => {
  const { bridge, requests, calls } = await fixture(t, { timeoutMs: 15,
    responsePull: () => { throw new Error('OBJECT_NOT_FOUND'); },
  });
  await assert.rejects(bridge.inspect('IMG_1234'), { code: 'BRIDGE_TIMEOUT' });
  assert.equal(requests.length, 1);
  returnedToPhotos(calls);
});

test('export rejects hash mismatch, wrong asset identity, unsafe helper output paths, and unedited output', async (t) => {
  for (const change of [
    { sha256: 'f'.repeat(64) }, { assetId: 'different-asset' }, { originalSHA256: 'd'.repeat(64) },
    { originalFilename: 'IMG_9999.HEIC' }, { outputFile: '../../other.jpg' }, { hasAdjustments: false },
  ]) {
    const { bridge, calls, folder } = await fixture(t, {
      response: (request, response) => request.action === 'export' ? { ...response, ...change } : response,
    });
    const baseline = await bridge.inspect('IMG_1234');
    await assert.rejects(bridge.exportResult(baseline, 'IMG_1234'), { code: 'PROTOCOL_INVALID' });
    assert.equal((await readdir(folder)).includes('IMG_1234-result.jpg'), false);
    returnedToPhotos(calls);
  }
});

test('malformed JPEG, decoder errors, and full-size dimension mismatches never publish a result', async (t) => {
  for (const options of [
    { jpeg: Buffer.from('not a JPEG') },
    { validateImage: async () => { throw new Error('corrupt JPEG decode'); } },
    { validateImage: async () => ({ width: 402, height: 874 }) },
  ]) {
    const { bridge, folder, calls } = await fixture(t, options);
    const baseline = await bridge.inspect('IMG_1234');
    await assert.rejects(bridge.exportResult(baseline, 'IMG_1234'));
    assert.equal((await readdir(folder)).includes('IMG_1234-result.jpg'), false);
    assert.equal((await readdir(path.join(folder, '.metadata'))).some((name) => name.startsWith('.jpeg-')), false);
    returnedToPhotos(calls);
  }
});

test('existing JPEG and a malicious output base are rejected before a device export', async (t) => {
  const { bridge, folder, requests } = await fixture(t);
  const baseline = await bridge.inspect('IMG_1234');
  const original = Buffer.from('preserve existing file');
  await writeFile(path.join(folder, 'IMG_1234-result.jpg'), original);
  await assert.rejects(bridge.exportResult(baseline, 'IMG_1234'), { code: 'OUTPUT_EXISTS' });
  for (const value of ['../outside', 'nested/IMG_1234', '.hidden', 'bad\\name']) {
    await assert.rejects(bridge.exportResult(baseline, value), { code: 'PROTOCOL_INVALID' });
  }
  assert.equal(requests.length, 1);
  assert.deepEqual(await readFile(path.join(folder, 'IMG_1234-result.jpg')), original);
});

test('pre-existing edits cannot be exported or reverted by this workflow', async (t) => {
  const { bridge, requests } = await fixture(t, { response: (_, response) => ({ ...response, hasAdjustments: true }) });
  const baseline = await bridge.inspect('IMG_1234');
  await assert.rejects(bridge.exportResult(baseline, 'IMG_1234'), { code: 'PROTOCOL_INVALID' });
  await assert.rejects(bridge.revert(baseline, {}), { code: 'PROTOCOL_INVALID' });
  assert.equal(requests.length, 1);
});

test('modified local bytes prevent any revert request', async (t) => {
  const { bridge, requests } = await fixture(t);
  const baseline = await bridge.inspect('IMG_1234');
  const receipt = await bridge.exportResult(baseline, 'IMG_1234');
  const changed = Buffer.from(jpeg);
  changed[4] ^= 1;
  await writeFile(receipt.localPath, changed);
  await assert.rejects(bridge.revert(baseline, receipt), { code: 'PROTOCOL_INVALID' });
  assert.equal(requests.length, 2);
});

test('symlinked JPEG, metadata directory, and cross-run receipts are rejected', async (t) => {
  const first = await fixture(t);
  const baseline = await first.bridge.inspect('IMG_1234');
  const receipt = await first.bridge.exportResult(baseline, 'IMG_1234');
  const second = await fixture(t);
  await assert.rejects(second.bridge.verifyLocalExport(receipt), { code: 'PROTOCOL_INVALID' });
  await rm(receipt.localPath);
  const elsewhere = path.join(second.folder, 'same.jpg');
  await writeFile(elsewhere, jpeg);
  await symlink(elsewhere, receipt.localPath);
  await assert.rejects(first.bridge.verifyLocalExport(receipt));
  const third = await fixture(t);
  await symlink(second.folder, path.join(third.folder, '.metadata'));
  await assert.rejects(third.bridge.inspect('IMG_1234'), { code: 'PROTOCOL_INVALID' });
  assert.equal(third.calls.length, 0);
});

test('revert must confirm original hash, asset identity, and removed adjustments', async (t) => {
  for (const change of [{ originalSHA256: 'd'.repeat(64) }, { hasAdjustments: true }, { restored: false }]) {
    const { bridge, calls } = await fixture(t, {
      response: (request, response) => request.action === 'revert' ? { ...response, ...change } : response,
    });
    const baseline = await bridge.inspect('IMG_1234');
    const receipt = await bridge.exportResult(baseline, 'IMG_1234');
    await assert.rejects(bridge.revert(baseline, receipt), { code: 'PROTOCOL_INVALID' });
    returnedToPhotos(calls);
  }
});

test('crash recovery finds only this run matching successful export receipt without phone calls', async (t) => {
  const { bridge, requests } = await fixture(t);
  const baseline = await bridge.inspect('IMG_1234');
  assert.equal(await bridge.findVerifiedExport(baseline, 'IMG_1234'), null);
  const receipt = await bridge.exportResult(baseline, 'IMG_1234');
  const recovered = await bridge.findVerifiedExport(baseline, 'IMG_1234');
  assert.equal(recovered.receiptPath, receipt.receiptPath);
  assert.equal(recovered.sha256, receipt.sha256);
  assert.equal(requests.length, 2);
  await assert.rejects(bridge.findVerifiedExport({ ...baseline, originalSHA256: 'd'.repeat(64) }, 'IMG_1234'),
    { code: 'PROTOCOL_INVALID' });
  assert.equal(await bridge.findVerifiedExport(baseline, 'IMG_1234-attempt-2'), null);
});

test('crash recovery rejects corrupt receipt and JPEG without phone calls', async (t) => {
  const { bridge, requests } = await fixture(t);
  const baseline = await bridge.inspect('IMG_1234');
  const receipt = await bridge.exportResult(baseline, 'IMG_1234');
  await writeFile(receipt.localPath, Buffer.from('broken JPEG'));
  await assert.rejects(bridge.findVerifiedExport(baseline, 'IMG_1234'));
  await writeFile(receipt.receiptPath, '{broken JSON');
  await assert.rejects(bridge.findVerifiedExport(baseline, 'IMG_1234'), { code: 'RECOVERY_RECORD_INVALID' });
  assert.equal(requests.length, 2);
});

test('verified export receipt survives failure to reactivate Photos', async (t) => {
  const { bridge, requests } = await fixture(t, { onPhotosActivate: (request) => {
    if (request.action === 'export') throw new Error('app activation failed');
  } });
  const baseline = await bridge.inspect('IMG_1234');
  await assert.rejects(bridge.exportResult(baseline, 'IMG_1234'), { code: 'PHOTOS_REACTIVATE_FAILED' });
  const recovered = await bridge.findVerifiedExport(baseline, 'IMG_1234');
  assert.equal(recovered.sha256, sha256);
  assert.equal(requests.length, 2);
});

test('sips validator decodes a real JPEG and reads its pixel dimensions offline', { skip: process.platform !== 'darwin' }, async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'photos-sips-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  // A small uncompressed BMP is an independent real decoder fixture.
  const bmp = path.join(folder, 'source.bmp');
  const pixels = Buffer.alloc(70, 0);
  pixels.write('BM');
  pixels.writeUInt32LE(70, 2);
  pixels.writeUInt32LE(54, 10);
  pixels.writeUInt32LE(40, 14);
  pixels.writeInt32LE(2, 18);
  pixels.writeInt32LE(2, 22);
  pixels.writeUInt16LE(1, 26);
  pixels.writeUInt16LE(24, 28);
  pixels.writeUInt32LE(16, 34);
  pixels.fill(255, 54);
  await writeFile(bmp, pixels);
  const jpg = path.join(folder, 'source.jpg');
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', bmp, '--out', jpg]);
  assert.deepEqual(await validateJPEGWithSips(jpg), { width: 2, height: 2 });
  const invalid = path.join(folder, 'invalid.jpg');
  await writeFile(invalid, jpeg);
  await assert.rejects(validateJPEGWithSips(invalid));
});
