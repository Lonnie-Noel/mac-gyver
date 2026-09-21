import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
export const signingPreferencePath = path.join(os.homedir(), 'Library', 'Application Support', 'MacGyverMacPhotos', 'signing.json');
const fingerprintPattern = /^[A-F0-9]{40}$/;
const supportedLabel = /^(Apple Development|Developer ID Application): /;
const defaultCommand = (executable, args) => execFileAsync(executable, args, { encoding: 'utf8' });

export function parseSigningIdentities(output) {
  const identities = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"([^"\r\n]+)"\s*$/);
    if (!match || !supportedLabel.test(match[2])) continue;
    const fingerprint = match[1].toUpperCase();
    if (!identities.some(identity => identity.fingerprint === fingerprint)) {
      identities.push({ fingerprint, label: match[2] });
    }
  }
  return identities;
}

function validatePreference(value, bundleId) {
  if (!value || value.version !== 1 || value.bundleId !== bundleId ||
      !fingerprintPattern.test(value.fingerprint ?? '') || !supportedLabel.test(value.label ?? '') ||
      !/^[A-Z0-9]{10}$/.test(value.teamIdentifier ?? '') ||
      typeof value.designatedRequirement !== 'string' || !value.designatedRequirement.trim() ||
      /[\r\n]|\bcdhash\b/.test(value.designatedRequirement)) {
    throw new Error('저장된 서명 설정이 올바르지 않습니다. signing.json을 확인하세요. 다른 인증서로 자동 전환하지 않습니다.');
  }
  return value;
}

export async function readSigningPreference(filename, bundleId) {
  let handle;
  try {
    // Do not follow a substituted symlink when reading the per-user identity pin.
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
      throw new Error('서명 설정은 현재 사용자 소유의 일반 파일이며 권한 600이어야 합니다. signing.json의 소유자와 권한을 확인하세요.');
    }
    return validatePreference(JSON.parse(await handle.readFile('utf8')), bundleId);
  } finally { await handle.close(); }
}

export async function resolveSigningIdentity({ bundleId, explicitIdentity = process.env.MACOS_SIGNING_IDENTITY,
  preferencePath = signingPreferencePath, command = defaultCommand } = {}) {
  const explicit = explicitIdentity?.trim();
  if (explicit === '-') {
    return { mode: 'adhoc', identity: '-', preferencePath, source: 'explicit', bundleId };
  }
  const saved = await readSigningPreference(preferencePath, bundleId);
  const { stdout } = await command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = parseSigningIdentities(stdout);
  let chosen;
  let source;
  if (explicit) {
    const matches = identities.filter(identity => identity.fingerprint === explicit.toUpperCase() || identity.label === explicit);
    if (matches.length !== 1) {
      throw new Error('MACOS_SIGNING_IDENTITY에 지정한 유효한 개발자 인증서를 하나로 확인할 수 없습니다. security find-identity -v -p codesigning으로 확인한 인증서의 SHA-1 전체 값을 지정하세요.');
    }
    chosen = matches[0];
    source = 'explicit';
  } else if (saved) {
    chosen = identities.find(identity => identity.fingerprint === saved.fingerprint);
    if (!chosen) throw new Error('이전에 저장한 서명 인증서를 키체인에서 찾을 수 없거나 만료되었습니다. 기존 인증서와 개인 키를 복구하거나 MACOS_SIGNING_IDENTITY로 사용할 인증서를 명시하세요. 임시 서명으로 대체하지 않습니다.');
    source = 'saved';
  } else {
    if (identities.length !== 1) {
      throw new Error(identities.length === 0
        ? '유효한 Apple Development 또는 Developer ID Application 서명 인증서가 없습니다. Xcode > Settings > Accounts > Manage Certificates에서 개발 인증서를 만든 뒤 다시 빌드하세요. 임시 서명으로 자동 대체하지 않습니다.'
        : '사용 가능한 개발자 서명 인증서가 여러 개입니다. security find-identity -v -p codesigning으로 확인하고 MACOS_SIGNING_IDENTITY에 사용할 인증서의 SHA-1 전체 값을 지정해 한 번 빌드하세요. 이후 같은 인증서를 기억합니다.');
    }
    [chosen] = identities;
    source = 'automatic';
  }
  return { ...chosen, mode: 'certificate', identity: chosen.fingerprint, bundleId, preferencePath, source,
    previous: saved?.fingerprint === chosen.fingerprint ? saved : null,
    changingIdentity: Boolean(saved && saved.fingerprint !== chosen.fingerprint) };
}

export function parseSignatureDetails(output) {
  return {
    bundleId: output.match(/^Identifier=(.+)$/m)?.[1]?.trim(),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim(),
    designatedRequirement: output.match(/^(?:# )?designated => (.+)$/m)?.[1]?.trim(),
    adhoc: /^Signature=adhoc$/m.test(output),
  };
}

export function validateSignature(selection, details, certificateBytes) {
  if (details.bundleId !== selection.bundleId) throw new Error('빌드된 앱의 번들 ID가 예상 값과 다릅니다.');
  if (selection.mode === 'adhoc') {
    if (!details.adhoc) throw new Error('요청한 임시 서명과 실제 앱 서명이 다릅니다.');
    return details;
  }
  if (details.adhoc || !certificateBytes?.length ||
      createHash('sha1').update(certificateBytes).digest('hex').toUpperCase() !== selection.fingerprint) {
    throw new Error('빌드된 앱의 서명 인증서가 선택한 인증서와 다릅니다. 기존 앱을 교체하지 않습니다.');
  }
  if (!/^[A-Z0-9]{10}$/.test(details.teamIdentifier ?? '') ||
      !details.designatedRequirement || /\bcdhash\b/.test(details.designatedRequirement)) {
    throw new Error('빌드된 앱의 안정적인 개발자 서명 식별 정보를 확인할 수 없습니다.');
  }
  if (selection.previous && (selection.previous.teamIdentifier !== details.teamIdentifier ||
      selection.previous.designatedRequirement !== details.designatedRequirement)) {
    throw new Error('같은 인증서의 앱 서명 식별 조건이 이전 빌드와 달라졌습니다. 권한이 유지되지 않을 수 있어 기존 앱을 교체하지 않습니다.');
  }
  return details;
}

export async function verifyAppSignature(appPath, selection, { command = defaultCommand } = {}) {
  await command('/usr/bin/codesign', ['--verify', '--strict', appPath]);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'macgyver-signature-'));
  try {
    const certificatePrefix = path.join(scratch, 'certificate-');
    const args = ['--display', '--verbose=4', '-r-'];
    // codesign treats this option's separated optional argument as another
    // code object. Keep the extraction prefix attached to the option.
    if (selection.mode === 'certificate') args.push(`--extract-certificates=${certificatePrefix}`);
    args.push(appPath);
    const { stdout, stderr } = await command('/usr/bin/codesign', args);
    const details = parseSignatureDetails(`${stdout ?? ''}\n${stderr ?? ''}`);
    const certificate = selection.mode === 'certificate' ? await fs.readFile(`${certificatePrefix}0`) : null;
    return validateSignature(selection, details, certificate);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

export async function saveSigningPreference(selection, details) {
  if (selection.mode === 'adhoc') return;
  const preference = validatePreference({ version: 1, bundleId: selection.bundleId,
    fingerprint: selection.fingerprint, label: selection.label, teamIdentifier: details.teamIdentifier,
    designatedRequirement: details.designatedRequirement }, selection.bundleId);
  const directory = path.dirname(selection.preferencePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) {
    throw new Error('서명 설정 폴더는 현재 사용자 소유의 디렉터리여야 합니다.');
  }
  await fs.chmod(directory, 0o700);
  const scratch = await fs.mkdtemp(path.join(directory, '.signing-'));
  try {
    const temporaryFile = path.join(scratch, 'signing.json');
    const handle = await fs.open(temporaryFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(preference, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporaryFile, selection.preferencePath);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
