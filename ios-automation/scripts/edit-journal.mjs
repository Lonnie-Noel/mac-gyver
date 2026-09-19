import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const pendingEditFile = path.join(root, 'artifacts', 'pending-photo-edit.json');

async function syncDirectory(filename) {
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeDurably(filename, data) {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export async function readPendingEdit(filename = pendingEditFile) {
  if (!existsSync(filename)) return null;
  const pending = JSON.parse(await readFile(filename, 'utf8'));
  if (pending.version !== 1 || typeof pending.id !== 'string' || !path.isAbsolute(pending.runDir ?? '')
    || !Number.isSafeInteger(pending.index) || pending.index < 1 || !pending.baseline?.assetId
    || !pending.entry?.outputBase || typeof pending.bundleId !== 'string') {
    throw new Error('Pending photo edit journal is invalid; inspect it before starting another run');
  }
  return pending;
}

export async function beginPendingEdit({ runDir, index, total, baseline, entry, bundleId }, filename = pendingEditFile) {
  if (baseline.hasAdjustments !== false) throw new Error('Existing edits must not be replaced by automatic JPEG export');
  const pending = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    runDir: path.resolve(runDir), index, total, baseline, entry, bundleId, phase: 'saving' };
  await mkdir(path.dirname(filename), { recursive: true });
  await writeDurably(filename, pending);
  await syncDirectory(filename);
  return pending;
}

export async function updatePendingEdit(pending, patch, filename = pendingEditFile) {
  if ((await readPendingEdit(filename))?.id !== pending.id) throw new Error('Another pending photo edit owns the recovery journal');
  const next = { ...pending, ...patch, id: pending.id, updatedAt: new Date().toISOString() };
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeDurably(temporary, next);
  await rename(temporary, filename);
  await syncDirectory(filename);
  return next;
}

export async function finishPendingEdit(pending, filename = pendingEditFile) {
  if ((await readPendingEdit(filename))?.id !== pending.id) throw new Error('Recovery journal ownership changed');
  await unlink(filename);
  await syncDirectory(filename);
}

// Recovery never applies a new edit. It exports an already saved result before
// restoring; an unsaved/cancelled draft is reported without claiming a result.
export async function recoverPendingEdit({ pending, bridge, verifyViewer, persist, stop = () => {}, filename = pendingEditFile }) {
  stop();
  await verifyViewer(pending);
  stop();
  // A saved edit can change dimensions. Recover by the recorded asset identity
  // and original hash, not by its now-stale initial selection hints or filename alone.
  const current = await bridge.inspect(pending.baseline.originalFilename, { preserveBaseline: true,
    assetId: pending.baseline.assetId, baselineOriginalSHA256: pending.baseline.originalSHA256 });
  if (current.assetId !== pending.baseline.assetId
    || current.originalSHA256 !== pending.baseline.originalSHA256
    || pending.baseline.hasAdjustments !== false) {
    throw new Error('Recovery photo identity or original bytes changed; automatic restoration stopped');
  }
  let receipt = pending.exportReceipt ?? await bridge.findVerifiedExport(pending.baseline, pending.entry.outputBase);
  stop();
  if (current.hasAdjustments) {
    receipt ??= await bridge.exportResult(pending.baseline, pending.entry.outputBase);
    stop();
    await bridge.verifyLocalExport(receipt);
    pending = await updatePendingEdit(pending, { phase: 'exported', exportReceipt: receipt }, filename);
    stop();
    await bridge.revert(pending.baseline, receipt);
  } else if (current.hasAdjustments !== false) {
    throw new Error('Cannot confirm whether the recovery photo still has edits');
  } else if (receipt) {
    await bridge.verifyLocalExport(receipt);
    stop();
    // Finish/verify a helper-side revert that may have completed before the
    // response reached this Mac. Keep its original baseline ledger intact.
    await bridge.revert(pending.baseline, receipt);
  }
  pending = await updatePendingEdit(pending, { phase: 'restored', exportReceipt: receipt ?? null }, filename);
  stop();
  await verifyViewer(pending);
  await persist(pending, receipt);
  await finishPendingEdit(pending, filename);
  return { recovered: true, resultSaved: !!receipt, receipt };
}
