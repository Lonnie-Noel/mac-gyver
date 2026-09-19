import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const runFile = promisify(execFile);
const directoryName = 'iphone-photos-automation';
export const releaseFiles = Object.freeze([
  'README.md', 'AGENTS.md', '.env.example', '.gitignore', 'package.json', 'package-lock.json',
  'scripts/smoke.mjs', 'scripts/phone.mjs', 'scripts/photos-batch.mjs', 'scripts/run-photos.mjs',
  'scripts/package-release.mjs', '사진 자동 캡처 시작.command', '사진 자동 캡처 중지.command',
  'scripts/capture-storage.mjs', 'scripts/photo-filename.mjs', 'scripts/export-bridge.mjs',
  'scripts/edit-journal.mjs', 'scripts/recover-photo.mjs', 'EDITED-IMAGE-EXPORT.md',
  'tests/capture-storage.test.mjs', 'tests/photo-filename.test.mjs', 'tests/photos-evidence.test.mjs',
  'tests/export-bridge.test.mjs', 'tests/edit-journal.test.mjs',
  'ExportBridge/README.md', 'ExportBridge/PhotosExportBridge/Info.plist',
  'ExportBridge/PhotosExportBridge/PhotosExportBridgeApp.swift', 'ExportBridge/PhotosExportBridge/BridgeWorker.swift',
  'ExportBridge/PhotosExportBridge.xcodeproj/project.pbxproj',
  'ExportBridge/PhotosExportBridge.xcodeproj/xcshareddata/xcschemes/PhotosExportBridge.xcscheme',
]);

// A quoted Appium path such as '@bundle.id:documents/file' is not an email.
const emailMatches = (text) => [...text.matchAll(/[A-Z0-9][A-Z0-9.!#$%&'*+/=?^_`{|}~-]*@([A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+)(?![A-Z0-9/-])/gi)];

// Report categories only: never copy the detected value into a build log.
export function validatePublicText(text, filename, publicPackageContacts = new Set()) {
  const problems = [];
  const homePaths = text.matchAll(/\/Users\/([^/\s"'<>`()[\]]+)/g);
  const exampleUser = /^(?:username|yourname|your[-_]?user(?:name)?|USER|사용자명|사용자이름)$/i;
  if ([...homePaths].some((match) => !exampleUser.test(match[1]))) problems.push('개인 Mac 홈 경로');
  const exampleDomain = /(?:^|\.)(?:example\.(?:com|org|net)|invalid|test|localhost)$/i;
  if (emailMatches(text).some((match) => !exampleDomain.test(match[1]) && !publicPackageContacts.has(match[0]))) problems.push('실제 이메일 주소');
  if (/(?<![A-Za-z0-9])[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16}(?![A-Za-z0-9])/.test(text)
    || /(?<![A-Za-z0-9])[A-Fa-f0-9]{40}(?![A-Za-z0-9])/.test(text)) problems.push('기기 UDID 또는 40자리 인증 식별자');
  // Standalone mixed-case-free 10-character IDs; exclude base64/integrity segments.
  const identifiers = text.matchAll(/(?<![A-Za-z0-9+/=_-])[A-Z0-9]{10}(?![A-Za-z0-9+/=_-])/g);
  const assignedTeam = /(?:IOS_TEAM_ID|DEVELOPMENT_TEAM|xcodeOrgId|TeamIdentifier|Team ID)[\s"'`]*[:=][\s"'`]*[A-Z0-9]{10}(?![A-Za-z0-9])/;
  if (assignedTeam.test(text) || [...identifiers].some(([value]) => /[A-Z]/.test(value) && /[0-9]/.test(value))) problems.push('Apple Team 또는 인증서 식별자');
  if (/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/.test(text)) problems.push('개인키');
  if (problems.length) throw new Error(`${filename}: 배포할 수 없는 정보가 감지됐습니다 (${problems.join(', ')}).`);
}

function registryDeprecationContacts(text) {
  const contacts = new Set();
  const lock = JSON.parse(text);
  for (const [name, metadata] of Object.entries(lock.packages ?? {})) {
    // Registry-authored public contact addresses are dependency metadata, not an owner's account.
    if (name.startsWith('node_modules/') && typeof metadata.integrity === 'string'
      && /^https:\/\/registry\.npmjs\.org\//.test(metadata.resolved ?? '') && typeof metadata.deprecated === 'string') {
      for (const [address] of emailMatches(metadata.deprecated)) contacts.add(address);
    }
  }
  return contacts;
}

export function validateEnvExample(text) {
  const requiredKeys = ['IOS_UDID', 'IOS_TEAM_ID', 'WDA_BUNDLE_ID'];
  const keys = new Set([...requiredKeys, 'IOS_EXPORT_BUNDLE_ID']);
  const found = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)\s*=\s*(?:#.*)?$/.exec(line);
    if (!match || !keys.has(match[1]) || found.has(match[1])) {
      throw new Error('.env.example에는 허용된 설정을 중복 없이 빈 값으로만 넣어야 합니다.');
    }
    found.add(match[1]);
  }
  if (!requiredKeys.every((key) => found.has(key))) throw new Error('.env.example에 필수 설정 세 개가 모두 있어야 합니다.');
}

async function regularFile(base, relative) {
  const segments = relative.split('/');
  let current = base;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === segments.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`${relative}: 심볼릭 링크 또는 일반 파일이 아닌 항목은 배포하지 않습니다.`);
    }
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${relative}: 일반 파일이 아닙니다.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function collectReleaseFiles(base = root) {
  const files = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const relative of releaseFiles) {
    const bytes = await regularFile(base, relative);
    let text;
    try { text = decoder.decode(bytes); }
    catch { throw new Error(`${relative}: 올바른 UTF-8 텍스트 파일이 아닙니다.`); }
    validatePublicText(text, relative, relative === 'package-lock.json' ? registryDeprecationContacts(text) : undefined);
    if (relative === '.env.example') validateEnvExample(text);
    files.push({ relative, bytes });
  }
  const pkg = JSON.parse(files.find((file) => file.relative === 'package.json').bytes.toString('utf8'));
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error('package.json의 version이 안전한 버전 형식이 아닙니다.');
  }
  return { files, version: pkg.version };
}

async function requireDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('배포 출력 경로는 실제 디렉터리여야 합니다.');
}

async function rejectUnsafeOutput(filename) {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('기존 배포 출력이 일반 파일이 아닙니다.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('사용법: node scripts/package-release.mjs [--check]');
  }
  const { files, version } = await collectReleaseFiles();
  if (args[0] === '--check') {
    console.log(`배포 검사 통과: 허용된 ${files.length}개 파일, 빈 설정 양식, 민감정보 패턴 검사. 압축 파일은 만들지 않았습니다.`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('배포 ZIP 생성에는 macOS의 ditto가 필요합니다.');
  const dist = path.join(root, 'dist');
  const archiveName = `${directoryName}-${version}.zip`;
  const archivePath = path.join(dist, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  let temporary;
  let publishing;
  try {
    temporary = await mkdtemp(path.join(tmpdir(), 'iphone-photos-release-'));
    const stagedRoot = path.join(temporary, directoryName);
    await mkdir(stagedRoot, { mode: 0o755 });
    for (const { relative, bytes } of files) {
      const destination = path.join(stagedRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      const mode = relative.endsWith('.command') ? 0o755 : 0o644;
      await writeFile(destination, bytes, { flag: 'wx', mode });
      await chmod(destination, mode);
    }
    const temporaryZip = path.join(temporary, archiveName);
    await runFile('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noacl', '--keepParent', stagedRoot, temporaryZip], {
      timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const checksum = createHash('sha256').update(await readFile(temporaryZip)).digest('hex');
    await requireDirectory(dist);
    await rejectUnsafeOutput(archivePath);
    await rejectUnsafeOutput(checksumPath);
    publishing = await mkdtemp(path.join(dist, '.release-'));
    const stagedZip = path.join(publishing, archiveName);
    const stagedChecksum = `${stagedZip}.sha256`;
    await copyFile(temporaryZip, stagedZip, constants.COPYFILE_EXCL);
    await chmod(stagedZip, 0o644);
    await writeFile(stagedChecksum, `${checksum}  ${archiveName}\n`, { flag: 'wx', mode: 0o644 });
    await rename(stagedZip, archivePath);
    await rename(stagedChecksum, checksumPath);
    console.log(`배포 ZIP: ${archivePath}\nSHA-256: ${checksumPath}\n포함 파일: ${files.length}개`);
  } finally {
    const cleanup = [temporary, publishing].filter(Boolean);
    const results = await Promise.allSettled(cleanup.map((directory) => rm(directory, { recursive: true, force: true })));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') console.error(`임시 디렉터리 정리 실패: ${cleanup[i]}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
