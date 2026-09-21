#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { requireNodeVersion } from './runtime.mjs';
import { resolveSigningIdentity, verifyAppSignature, saveSigningPreference } from './signing.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(projectRoot, 'build');
const logRoot = path.join(projectRoot, 'logs');
const logPath = path.join(logRoot, 'build.log');
const appPath = path.join(buildRoot, 'MacPhotosBridge.app');
const markerPath = path.join(buildRoot, '.source-hash');
const bundleId = 'local.macgyver.photosautomation';
let temporaryRoot;
let buildLog;

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function requireStoppedBridge() {
  let running = false;
  try {
    const result = await execFileAsync('/usr/bin/pgrep', ['-x', 'MacPhotosBridge'], { encoding: 'utf8' });
    running = result.stdout.trim().length > 0;
  } catch (error) {
    // pgrep returns 1 when no process has the exact requested name.
    if (error.code !== 1) throw error;
  }
  if (running) {
    throw new Error('MacPhotosBridge가 실행 중입니다. 도우미 설정 창의 “보조 앱 종료” 버튼 또는 활성 상태 보기에서 종료한 뒤 다시 빌드하세요. 실행 중인 앱을 자동 종료하지 않습니다.');
  }
}

async function command(executable, args) {
  await buildLog?.appendFile(`\n${executable} ${JSON.stringify(args)}\n`);
  try {
    const result = await execFileAsync(executable, args, {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    await buildLog?.appendFile(result.stdout + result.stderr);
    return result;
  } catch (error) {
    await buildLog?.appendFile((error.stdout || '') + (error.stderr || '') + `${error.message}\n`);
    throw error;
  }
}

async function main() {
  requireNodeVersion();
  if (process.platform !== 'darwin') throw new Error('이 빌드는 macOS에서만 실행할 수 있습니다.');
  if (await exists(path.join(projectRoot, 'artifacts', 'pending-edit.json'))) {
    throw new Error('미완료 편집 기록이 있습니다. 기존 앱으로 recover를 완료한 뒤 빌드하세요.');
  }
  const nativeRoot = path.join(projectRoot, 'native');
  const swiftSources = (await fs.readdir(nativeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.swift'))
    .map((entry) => path.join(nativeRoot, entry.name)).sort();
  if (swiftSources.length === 0) throw new Error('native/*.swift 소스가 없습니다.');
  const plistPath = path.join(nativeRoot, 'Info.plist');
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`지원하지 않는 Mac 아키텍처입니다: ${process.arch}`);
  const signing = await resolveSigningIdentity({ bundleId, command });
  const signingIdentity = signing.identity;
  if (signing.mode === 'adhoc') {
    console.warn('MACOS_SIGNING_IDENTITY=- 요청으로 임시 서명을 사용합니다. 재빌드 후 권한 재승인이 필요할 수 있으며 저장된 개발자 인증서는 변경하지 않습니다.');
  } else if (signing.changingIdentity) {
    console.warn('명시한 새 개발자 인증서로 변경합니다. 이번 빌드 후 macOS 권한 재승인이 필요할 수 있습니다.');
  } else {
    console.log(signing.source === 'automatic'
      ? '유효한 개발자 인증서 하나를 선택했습니다. 서명 검증 후 저장하고 다음 빌드에도 같은 인증서를 사용합니다.'
      : '저장하거나 명시한 개발자 인증서로 서명합니다.');
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ bundleId, signingIdentity, arch }));
  for (const filename of [...swiftSources, plistPath, fileURLToPath(import.meta.url), fileURLToPath(new URL('./signing.mjs', import.meta.url))]) {
    hash.update(path.relative(projectRoot, filename));
    hash.update('\0');
    hash.update(await fs.readFile(filename));
    hash.update('\0');
  }
  const sourceHash = hash.digest('hex');
  let previousHash = '';
  try { previousHash = (await fs.readFile(markerPath, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  if (previousHash === sourceHash && await exists(path.join(appPath, 'Contents', 'MacOS', 'MacPhotosBridge'))) {
    try {
      const signature = await verifyAppSignature(appPath, signing, { command });
      await saveSigningPreference(signing, signature);
      console.log(`소스 변경 없음: 기존 앱을 사용합니다.\n${appPath}`);
      return;
    } catch {
      console.log('기존 앱 서명을 검증할 수 없어 다시 빌드합니다.');
    }
  }

  await requireStoppedBridge();

  await fs.mkdir(buildRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(logRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(logRoot, 0o700);
  buildLog = await fs.open(logPath, 'w', 0o600);
  await buildLog.chmod(0o600);
  await buildLog.appendFile(`MacPhotosBridge build ${new Date().toISOString()}\n`);
  temporaryRoot = await fs.mkdtemp(path.join(buildRoot, '.bridge-build-'));
  const temporaryApp = path.join(temporaryRoot, 'MacPhotosBridge.app');
  const contentsPath = path.join(temporaryApp, 'Contents');
  const executablePath = path.join(contentsPath, 'MacOS', 'MacPhotosBridge');
  await fs.mkdir(path.dirname(executablePath), { recursive: true, mode: 0o755 });
  await fs.copyFile(plistPath, path.join(contentsPath, 'Info.plist'));
  await command('/usr/bin/plutil', ['-lint', path.join(contentsPath, 'Info.plist')]);
  const compilerArgs = [
    'swiftc', '-swift-version', '5', '-parse-as-library', '-target', `${arch}-apple-macosx15.2`, '-O',
    '-module-cache-path', path.join(buildRoot, '.module-cache'),
    '-framework', 'Foundation', '-framework', 'AppKit',
    '-framework', 'ApplicationServices', '-framework', 'Photos',
    '-framework', 'ScreenCaptureKit', '-framework', 'CoreGraphics', '-framework', 'ImageIO',
    '-framework', 'CoreImage', '-framework', 'CryptoKit', '-framework', 'UniformTypeIdentifiers',
    ...swiftSources, '-o', executablePath,
  ];
  console.log('Mac 사진 자동화 도우미를 빌드합니다.');
  await command('/usr/bin/xcrun', compilerArgs);
  await fs.chmod(executablePath, 0o755);
  await command('/usr/bin/codesign', ['--force', '--sign', signingIdentity, '--identifier', bundleId, temporaryApp]);
  const signature = await verifyAppSignature(temporaryApp, signing, { command });

  // A helper launched while compilation was running must not keep an old binary alive.
  await requireStoppedBridge();

  // Keep the previous app until the replacement is fully compiled and signed.
  const previousApp = path.join(temporaryRoot, 'previous.app');
  const hadPreviousApp = await exists(appPath);
  if (hadPreviousApp) await fs.rename(appPath, previousApp);
  try {
    await fs.rename(temporaryApp, appPath);
    await saveSigningPreference(signing, signature);
  } catch (error) {
    // A signing preference write failure must not strand a replacement app
    // without the certificate pin needed by the next build.
    await fs.rm(appPath, { recursive: true, force: true });
    if (hadPreviousApp) await fs.rename(previousApp, appPath);
    throw error;
  }
  const temporaryMarker = path.join(temporaryRoot, 'source-hash');
  await fs.writeFile(temporaryMarker, `${sourceHash}\n`, { mode: 0o600 });
  await fs.rename(temporaryMarker, markerPath);
  console.log(`빌드와 서명 검증 완료:\n${appPath}\n로그: ${logPath}`);
  if (signing.mode === 'certificate') {
    console.log(`개발자 인증서와 서명 식별 조건을 저장했습니다: ${signing.preferencePath}\n같은 인증서로 재빌드해도 macOS 정책이나 인증서 변경에 따라 다시 승인이 필요할 수 있습니다.`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`빌드 실패: ${error.message}`);
  if (buildLog) console.error(`상세 로그: ${logPath}`);
  process.exitCode = 1;
} finally {
  await buildLog?.close();
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
}
