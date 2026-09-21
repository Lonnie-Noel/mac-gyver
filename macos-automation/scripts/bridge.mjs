import { mkdir, lstat, readFile, writeFile, rename, open, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const ipcRoot = path.join(os.homedir(), 'Library/Application Support/MacGyverMacPhotos');
export const appPath = path.join(root, 'build/MacPhotosBridge.app');
const execute = promisify(execFile);
const clientSessionId = randomUUID();
let clientIdentityPromise;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function clientIdentity() {
  // This CLI branch only reads kernel process metadata; it does not start the
  // accessory app, access Photos, or request permissions.
  if (!clientIdentityPromise) {
    clientIdentityPromise = execute(path.join(appPath, 'Contents/MacOS/MacPhotosBridge'),
      ['--client-identity', String(process.pid)], { timeout: 10_000, maxBuffer: 16_384 })
      .then(({ stdout }) => {
        const identity = JSON.parse(stdout);
        if (identity.pid !== process.pid || identity.uid !== process.getuid()
            || !/^\d+:\d{1,6}$/.test(identity.processStart ?? '')) {
          throw new Error('실행 프로세스의 시작 정보를 확인할 수 없습니다. 보조 앱을 다시 빌드하세요.');
        }
        return { ...identity, sessionId: clientSessionId };
      }).catch(error => { clientIdentityPromise = undefined; throw error; });
  }
  return clientIdentityPromise;
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('실제 디렉터리가 필요합니다.');
}
export async function atomicJSON(file, value, { exclusive = false } = {}) {
  await privateDirectory(path.dirname(file));
  if (existsSync(file)) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || exclusive) throw new Error('기존 기록을 덮어쓸 수 없습니다.');
  }
  const temp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) {
      const { link } = await import('node:fs/promises');
      await link(temp, file); await unlink(temp);
    } else await rename(temp, file);
    const parent = await open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function readJSON(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('안전하지 않은 JSON 기록입니다.');
  return JSON.parse(await readFile(file, 'utf8'));
}
export function createBridge({ base = ipcRoot, timeoutMs = 600_000, onRequest } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('보조 앱 대기 시간은 양의 정수여야 합니다.');
  let busy = false;
  return { async call(action, args = {}) {
    if (busy) throw new Error('보조 앱 요청을 병렬 실행할 수 없습니다.');
    busy = true;
    const id = randomUUID();
    try {
      const client = await clientIdentity();
      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + timeoutMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new Error('보조 앱 요청 만료 시간이 유효하지 않습니다.');
      const request = { id, action, args, protocolVersion: 2, client, createdAtMs, expiresAtMs };
      await privateDirectory(base); await privateDirectory(path.join(base, 'inbox')); await privateDirectory(path.join(base, 'outbox'));
      await onRequest?.(request);
      await atomicJSON(path.join(base, 'inbox', `${id}.json`), request, { exclusive: true });
      const output = path.join(base, 'outbox', `${id}.json`);
      const deadline = expiresAtMs;
      while (Date.now() < deadline) {
        if (existsSync(output)) {
          const response = await readJSON(output);
          if (response.id !== id || typeof response.ok !== 'boolean') throw new Error('보조 앱 응답 ID 또는 형식이 일치하지 않습니다.');
          if (!response.ok) throw new Error(response.error || '보조 앱 작업이 실패했습니다.');
          if (!response.result || typeof response.result !== 'object') throw new Error('보조 앱 결과가 없습니다.');
          return response.result;
        }
        await sleep(200);
      }
      throw new Error(`보조 앱 응답 시간초과 (${action}). 요청을 자동 재전송하지 않습니다. 저장 중이었다면 recover를 실행하세요.`);
    } finally { busy = false; }
  } };
}
export async function startBridge() {
  if (process.platform !== 'darwin') throw new Error('macOS 전용 자동화입니다.');
  if (!existsSync(path.join(appPath, 'Contents/MacOS/MacPhotosBridge'))) throw new Error('보조 앱이 없습니다. 먼저 npm run build 또는 설정 파일을 실행하세요.');
  // Reopening the app explicitly shows its settings window. Automation should
  // reuse the running helper without sending a reopen event or stealing focus.
  if (!await bridgeIsRunning()) {
    await execute('/usr/bin/open', ['-g', appPath, '--args', '--background'], { timeout: 15_000 });
  }
  const bridge = createBridge({ timeoutMs: 30_000 });
  const status = await bridge.call('status');
  if (status.protocolVersion !== 2 || await realpath(status.executable) !== await realpath(path.join(appPath, 'Contents/MacOS/MacPhotosBridge'))) {
    throw new Error('다른 위치/버전의 보조 앱이 실행 중입니다. 기존 MacPhotosBridge를 종료한 뒤 다시 실행하세요.');
  }
  return status;
}

export async function bridgeIsRunning() {
  const { stdout } = await execute('/bin/ps', ['-ax', '-o', 'comm='], { timeout: 10_000 });
  const executable = path.join(appPath, 'Contents/MacOS/MacPhotosBridge');
  return stdout.split('\n').some(line => line.trim() === executable);
}
