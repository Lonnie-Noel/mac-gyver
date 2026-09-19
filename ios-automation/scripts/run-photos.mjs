import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, getSession, mobile, request } from './phone.mjs';
import { parseState } from './photos-batch.mjs';
import { readPendingEdit } from './edit-journal.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
const workflowLock = path.join(artifacts, '.photos-workflow.lock');
const workflowStop = path.join(artifacts, '.photos-workflow-stop');
const activeRunFile = path.join(artifacts, 'active-photos-run.json');
const sessionFile = path.join(artifacts, 'active-session.json');
const args = process.argv.slice(2);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function activeBatches() {
  const found = [];
  if (!existsSync(artifacts)) return found;
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(artifacts, entry.name);
    const lock = path.join(directory, '.batch.lock');
    if (existsSync(lock) && alive(Number((await readFile(lock, 'utf8')).trim()))) found.push(directory);
  }
  return found;
}

async function stopRunning() {
  const runs = await activeBatches();
  let preparing = false;
  if (existsSync(workflowLock)) {
    const pid = Number((await readFile(workflowLock, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid)) {
      await writeFile(workflowStop, '사용자가 실행 준비 중지를 요청했습니다.\n');
      preparing = true;
    }
  }
  if (!runs.length && !preparing) {
    console.log('현재 반복 처리 중인 작업이 없습니다.');
    return;
  }
  if (preparing) console.log('실행 프로그램에 중지를 요청했습니다. 연결 준비 중이면 현재 연결 요청이 끝난 뒤 멈춥니다.');
  for (const directory of runs) {
    await writeFile(path.join(directory, 'STOP'), '사용자가 중지를 요청했습니다.\n');
    console.log(`중지 요청을 보냈습니다: ${directory}`);
  }
  console.log('현재 요청이 끝나면 다음 단계 전에 멈춥니다. 편집 화면이 남아 있으면 취소로 원래 사진 화면에 돌아가세요.');
}

async function serverReady() {
  try {
    const response = await fetch('http://127.0.0.1:4723/status', { signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.json()).value?.ready === true;
  } catch { return false; }
}

async function ensureServer(stopped) {
  if (await serverReady()) return;
  const logs = path.join(root, 'logs');
  await mkdir(logs, { recursive: true });
  const output = openSync(path.join(logs, 'appium-launcher.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'node_modules/appium/index.js'),
    '--address', '127.0.0.1', '--port', '4723', '--base-path', '/',
    '--log-level', 'info', '--log-no-colors', '--log', path.join(logs, 'appium.log')],
  { cwd: root, detached: true, stdio: ['ignore', output, output] });
  closeSync(output);
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.unref();
  console.log('로컬 자동화 서버를 시작합니다…');
  for (let i = 0; i < 30; i++) {
    if (stopped()) return;
    if (spawnError) throw spawnError;
    if (await serverReady()) return;
    await delay(1000);
  }
  throw new Error('Appium 서버가 준비되지 않았습니다. logs/appium-launcher.log를 확인하세요.');
}

async function runChild(script, childArgs = [], onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...childArgs],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line) onLine ? onLine(line) : console.log(line);
    });
    child.stderr.on('data', (text) => process.stderr.write(text));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (buffer) onLine ? onLine(buffer) : console.log(buffer);
      code === 0 ? resolve() : reject(new Error(`자동화가 중단되었습니다 (${code ?? signal}). 결과 폴더의 manifest.json을 확인하세요.`));
    });
  });
}

async function checkInstallation() {
  const required = ['.env', 'node_modules/appium/index.js', 'scripts/phone.mjs', 'scripts/photos-batch.mjs'];
  for (const file of required) if (!existsSync(path.join(root, file))) throw new Error(`필요한 파일이 없습니다: ${file}`);
  await runChild('smoke.mjs', ['--check']);
}

async function main() {
  if (args.length === 1 && args[0] === '--stop') return stopRunning();
  if (args.length === 1 && args[0] === '--check') {
    await checkInstallation();
    console.log('실행 파일 준비 확인 완료. 이 검사는 아이폰을 조작하지 않습니다.');
    return;
  }
  const recoverOnly = args.length === 1 && args[0] === '--recover';
  if (args.length && !recoverOnly) throw new Error('사용법: node scripts/run-photos.mjs [--stop | --check | --recover]');
  await checkInstallation();
  const pending = await readPendingEdit();
  if (pending && !recoverOnly) throw new Error('저장된 사진의 복원이 필요합니다. 먼저 npm run photos:recover를 실행하세요.');
  if (recoverOnly && !pending) { console.log('복원이 필요한 사진 기록이 없습니다.'); return; }
  await mkdir(artifacts, { recursive: true });
  if ((await activeBatches()).length) throw new Error('이미 사진 반복 작업이 진행 중입니다. 시작 파일을 다시 실행할 필요가 없습니다.');
  if (existsSync(workflowLock)) {
    const pid = Number((await readFile(workflowLock, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('사진 자동화 프로그램이 시작 중이거나 잠금 파일 확인이 필요합니다. 중복 실행하지 마세요.');
    if (alive(pid)) throw new Error('이미 사진 자동화 프로그램이 실행 중입니다.');
    await unlink(workflowLock);
  }
  if (existsSync(workflowStop)) await unlink(workflowStop);
  const lock = await open(workflowLock, 'wx');
  await lock.writeFile(`${process.pid}\n`);
  let session;
  let runDir;
  let stopRequested = false;
  const stopped = () => stopRequested || existsSync(workflowStop);
  const stopMonitor = setInterval(() => {
    if (stopped() && runDir) writeFile(path.join(runDir, 'STOP'), '사용자가 중지를 요청했습니다.\n').catch(() => {});
  }, 500);
  stopMonitor.unref();
  const stop = () => {
    stopRequested = true;
    writeFile(workflowStop, '터미널에서 중지를 요청했습니다.\n').catch(() => {});
    if (runDir) writeFile(path.join(runDir, 'STOP'), '터미널에서 중지를 요청했습니다.\n').catch(() => {});
    console.log('중지를 요청했습니다. 현재 요청이 끝날 때까지 기다려 주세요.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await ensureServer(stopped);
    if (stopped()) return;
    if (existsSync(sessionFile)) {
      const existing = await getSession();
      try { await command(existing, 'GET', '/window/rect'); session = existing; }
      catch (error) {
        if (!error.message.includes('invalid session id')) throw error;
        await unlink(sessionFile);
      }
    }
    if (stopped()) return;
    if (!session) {
      console.log('아이폰 자동화 연결을 준비합니다…');
      await runChild('phone.mjs', ['start']);
      session = await getSession();
    }
    if (stopped()) return;
    if (recoverOnly) {
      await runChild('recover-photo.mjs');
      return;
    }
    const active = await mobile(session, 'activeAppInfo');
    if (active.bundleId !== 'com.apple.mobileslideshow') throw new Error('아이폰 사진 앱에서 작업할 앨범의 사진 한 장을 연 뒤 다시 시작해 주세요.');
    const state = parseState(await command(session, 'GET', '/source'));
    if (!state.viewer || !state.photo || !state.editAvailable) throw new Error('편집 화면이 아닌, 앨범의 사진 한 장을 열어 둔 화면에서 시작해 주세요.');
    const rect = await command(session, 'GET', '/window/rect');
    if (rect.width !== 402 || rect.height !== 874) throw new Error('현재 화면 크기는 아직 검증되지 않았습니다. 아이폰을 세로 방향으로 두세요.');
    runDir = path.join(artifacts, `photos-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(runDir);
    await writeFile(activeRunFile, `${JSON.stringify({ pid: process.pid, runDir, startedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`앨범 ${state.photo.total}장 / 현재 ${state.photo.index}번째 사진부터 시작합니다.`);
    console.log(`결과 폴더: ${runDir}`);
    console.log('아이폰의 잠금을 풀어 두고, 완료될 때까지 화면을 직접 조작하지 마세요.');
    let completed = 0;
    const names = { 'before-filename': '원래 파일명 확인', 'before-edit': '편집 시작', 'before-generation': '재생성 전 캡처 저장',
      'generation-requested': '사진 재생성 중 — 최소 25초 대기', 'after-generation': '재생성 후 캡처 저장',
      'result-saved': '편집 결과 적용 완료', 'result-exported': 'JPEG 파일 저장·검증 완료', 'original-restored': '원본 복원 완료' };
    if (stopped()) return;
    await runChild('photos-batch.mjs', ['--run-dir', runDir, '--total', String(state.photo.total),
      '--start-index', String(state.photo.index)], (line) => {
      let event;
      try { event = JSON.parse(line); } catch { console.log(line); return; }
      if (event.stage === 'photo-complete') console.log(`[${++completed}/${state.photo.total} 완료] ${event.index}번째 사진`);
      else if (event.stage === 'photo-skipped') console.log(`${event.skippedIndex}번째 사진: 기존 편집이 있어 건너뜁니다.`);
      else if (names[event.stage]) console.log(`${event.index}번째 사진: ${names[event.stage]}`);
    });
    const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    if (manifest.status !== 'complete') throw new Error('전체 완료로 확인되지 않았습니다. 결과 폴더의 처리 상태를 확인하세요.');
    const done = Object.values(manifest.photos).filter((entry) => entry.status === 'complete');
    const skipped = Object.values(manifest.photos).filter((entry) => entry.status === 'skipped-existing-edits');
    const exported = done.filter((entry) => entry.outputMode === 'jpeg-export').length;
    console.log(`완료: ${done.length}장, 캡처 ${done.length * 2}개, JPEG ${exported}개, 기존 편집으로 건너뜀 ${skipped.length}장`);
    console.log(`저장 위치: ${runDir}`);
  } finally {
    clearInterval(stopMonitor);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (session) {
      try {
        await request('DELETE', `/session/${session}`);
        if (existsSync(sessionFile) && await getSession() === session) await unlink(sessionFile);
      } catch (error) { console.error(`연결 종료 확인 필요: ${error.message}`); }
    }
    if (existsSync(activeRunFile)) await unlink(activeRunFile);
    if (existsSync(workflowStop)) await unlink(workflowStop);
    await lock.close();
    await unlink(workflowLock);
  }
}

main().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1; });
