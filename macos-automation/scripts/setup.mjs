import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { appPath, root, bridgeIsRunning, startBridge, createBridge } from './bridge.mjs';

function buildHelper() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`도우미 빌드를 완료하지 못했습니다 (종료 코드 ${code}).`)));
  });
}

export async function openSettings({
  isRunning = bridgeIsRunning,
  hasPending = () => existsSync(path.join(root, 'artifacts/pending-edit.json')),
  hasApp = () => existsSync(path.join(appPath, 'Contents/MacOS/MacPhotosBridge')),
  build = buildHelper,
  show = async () => { await startBridge(); await createBridge().call('showSetup'); },
  log = console.log,
} = {}) {
  if (await isRunning()) {
    await show();
    log('실행 중인 도우미의 설정 창을 다시 열었습니다. 업데이트하려면 보조 앱 종료 후 설정 커맨드를 다시 실행하세요.');
    return 'reopened';
  }
  if (hasPending()) {
    if (!hasApp()) throw new Error('미완료 편집 기록이 있고 기존 도우미를 찾지 못했습니다. 기록을 보존한 채 기존 앱을 복원하세요.');
    await show();
    log('미완료 편집을 복구할 수 있도록 기존 도우미의 설정 창을 열었습니다. 빌드는 복구 후 진행하세요.');
    return 'recovery';
  }
  await build();
  await show();
  log('설정 창을 열었습니다. 네 권한을 하나씩 요청하세요. 재빌드 후 권한이 꼬였으면 이 앱 권한 초기화 후 종료를 누르고 설정 커맨드를 다시 실행하세요.');
  return 'ready';
}
