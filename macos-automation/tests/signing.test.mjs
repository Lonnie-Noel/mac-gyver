import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSigningIdentities, resolveSigningIdentity, readSigningPreference,
  parseSignatureDetails, validateSignature, verifyAppSignature, saveSigningPreference } from '../scripts/signing.mjs';

const bundleId = 'local.macgyver.photosautomation';
const certificate = Buffer.from('test-only mocked DER certificate');
const fingerprint = createHash('sha1').update(certificate).digest('hex').toUpperCase();
const otherFingerprint = 'B'.repeat(40);
const label = 'Apple Development: Test Developer (ABCDEFGHIJ)';
const otherLabel = 'Developer ID Application: Test Distribution (ABCDEFGHIJ)';
const designatedRequirement = `identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = ABCDEFGHIJ`;
const details = { bundleId, teamIdentifier: 'ABCDEFGHIJ', designatedRequirement, adhoc: false };
const identityLine = (hash = fingerprint, name = label) => `  1) ${hash} "${name}"`;
const saved = { version: 1, bundleId, fingerprint, label,
  teamIdentifier: details.teamIdentifier, designatedRequirement };

async function fixture(t, { output = `${identityLine()}\n     1 valid identities found`, preference } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'macgyver-signing-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preferencePath = path.join(directory, 'state', 'signing.json');
  if (preference) {
    await fs.mkdir(path.dirname(preferencePath), { mode: 0o700 });
    await fs.writeFile(preferencePath, JSON.stringify(preference), { mode: 0o600 });
  }
  const calls = [];
  const options = { bundleId, explicitIdentity: '', preferencePath,
    command: async (executable, args) => { calls.push([executable, args]); return { stdout: output, stderr: '' }; } };
  return { directory, preferencePath, calls, options };
}

test('identity parsing ignores unsupported, invalid, expired, and duplicate entries', () => {
  const output = [identityLine(), identityLine(), identityLine(otherFingerprint, otherLabel),
    identityLine('C'.repeat(40), 'Apple Distribution: Test (ABCDEFGHIJ)'),
    `${identityLine('D'.repeat(40))} (CSSMERR_TP_CERT_REVOKED)`,
    '  5) BAD "Apple Development: Invalid"', ' 4 valid identities found'].join('\n');
  assert.deepEqual(parseSigningIdentities(output), [{ fingerprint, label }, { fingerprint: otherFingerprint, label: otherLabel }]);
});

test('first build selects the only valid developer identity without persisting before verification', async t => {
  const { options, calls, preferencePath } = await fixture(t);
  const selected = await resolveSigningIdentity(options);
  assert.equal(selected.identity, fingerprint);
  assert.equal(selected.source, 'automatic');
  assert.deepEqual(calls, [['/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']]]);
  await assert.rejects(fs.access(preferencePath), { code: 'ENOENT' });
});

test('first build with multiple identities requires an explicit choice', async t => {
  const { options } = await fixture(t, { output: `${identityLine()}\n${identityLine(otherFingerprint, otherLabel)}` });
  await assert.rejects(resolveSigningIdentity(options), /인증서가 여러 개/);
});

test('missing valid identities never silently choose ad hoc', async t => {
  const { options } = await fixture(t, { output: ' 0 valid identities found' });
  await assert.rejects(resolveSigningIdentity(options), /인증서가 없습니다/);
});

test('saved fingerprint wins over additional identities on subsequent builds', async t => {
  const { options } = await fixture(t, { preference: saved,
    output: `${identityLine(otherFingerprint, otherLabel)}\n${identityLine()}` });
  const selected = await resolveSigningIdentity(options);
  assert.equal(selected.identity, fingerprint);
  assert.equal(selected.source, 'saved');
  assert.deepEqual(selected.previous, saved);
});

test('missing saved certificate stops rather than adopting the sole replacement', async t => {
  const { options } = await fixture(t, { preference: saved, output: identityLine(otherFingerprint, otherLabel) });
  await assert.rejects(resolveSigningIdentity(options), /이전에 저장한 서명 인증서/);
});

test('explicit full fingerprint selects and records an intentional certificate change', async t => {
  const { options } = await fixture(t, { preference: saved,
    output: `${identityLine()}\n${identityLine(otherFingerprint, otherLabel)}` });
  const selected = await resolveSigningIdentity({ ...options, explicitIdentity: otherFingerprint.toLowerCase() });
  assert.equal(selected.identity, otherFingerprint);
  assert.equal(selected.changingIdentity, true);
  assert.equal(selected.previous, null);
});

test('an exact certificate label is supported but ambiguous labels fail', async t => {
  const { options } = await fixture(t);
  assert.equal((await resolveSigningIdentity({ ...options, explicitIdentity: label })).identity, fingerprint);
  const duplicate = await fixture(t, { output: `${identityLine()}\n${identityLine(otherFingerprint)}` });
  await assert.rejects(resolveSigningIdentity({ ...duplicate.options, explicitIdentity: label }), /하나로 확인/);
});

test('explicit ad hoc signing bypasses keychain lookup and never overwrites the certificate pin', async t => {
  const { options, calls, preferencePath } = await fixture(t, { preference: saved });
  const selected = await resolveSigningIdentity({ ...options, explicitIdentity: '-' });
  assert.equal(selected.mode, 'adhoc');
  await saveSigningPreference(selected, { bundleId, adhoc: true });
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(preferencePath, 'utf8')), saved);
});

test('verification metadata accepts implicit and explicit designated requirement display', () => {
  for (const prefix of ['', '# ']) {
    assert.deepEqual(parseSignatureDetails(`Identifier=${bundleId}\nTeamIdentifier=ABCDEFGHIJ\n${prefix}designated => ${designatedRequirement}`), details);
  }
});

test('signed app must have the selected leaf certificate, bundle ID, stable requirement and team', () => {
  const selected = { mode: 'certificate', fingerprint, bundleId, previous: saved };
  assert.equal(validateSignature(selected, details, certificate), details);
  assert.throws(() => validateSignature(selected, details, Buffer.from('different certificate')), /서명 인증서/);
  assert.throws(() => validateSignature(selected, { ...details, bundleId: 'another.app' }, certificate), /번들 ID/);
  assert.throws(() => validateSignature(selected, { ...details, adhoc: true }, certificate), /서명 인증서/);
  assert.throws(() => validateSignature(selected, { ...details, teamIdentifier: 'not set' }, certificate), /안정적인/);
  assert.throws(() => validateSignature(selected, { ...details, designatedRequirement: 'cdhash H"123"' }, certificate), /안정적인/);
  assert.throws(() => validateSignature(selected, { ...details, designatedRequirement: `${designatedRequirement} and true` }, certificate), /이전 빌드와 달라/);
  assert.throws(() => validateSignature(selected, { ...details, teamIdentifier: 'ZYXWVUTSRQ' }, certificate), /이전 빌드와 달라/);
});

test('verifyAppSignature validates actual extracted leaf bytes after codesign integrity verification', async t => {
  const { options } = await fixture(t);
  const selection = await resolveSigningIdentity(options);
  const calls = [];
  let extractionDirectory;
  const result = await verifyAppSignature('/mock/MacPhotosBridge.app', selection, {
    command: async (executable, args) => {
      calls.push([executable, args]);
      if (args[0] === '--verify') return { stdout: '', stderr: '' };
      const extraction = args.find(arg => arg.startsWith('--extract-certificates='));
      assert.ok(extraction, 'codesign optional extraction argument must use = syntax');
      const prefix = extraction.slice('--extract-certificates='.length);
      extractionDirectory = path.dirname(prefix);
      await fs.writeFile(`${prefix}0`, certificate);
      return { stdout: `designated => ${designatedRequirement}`, stderr: `Identifier=${bundleId}\nTeamIdentifier=ABCDEFGHIJ` };
    },
  });
  assert.deepEqual(result, details);
  assert.deepEqual(calls[0], ['/usr/bin/codesign', ['--verify', '--strict', '/mock/MacPhotosBridge.app']]);
  await assert.rejects(fs.access(extractionDirectory), { code: 'ENOENT' });
});

test('signature verification failure does not proceed to metadata inspection', async t => {
  const { options } = await fixture(t);
  const selection = await resolveSigningIdentity(options);
  let calls = 0;
  await assert.rejects(verifyAppSignature('/mock/app', selection, {
    command: async () => { calls++; throw new Error('invalid signature'); },
  }), /invalid signature/);
  assert.equal(calls, 1);
});

test('certificate preference persists atomically with user-only directory and file permissions', async t => {
  const { options, preferencePath } = await fixture(t);
  const selection = await resolveSigningIdentity(options);
  validateSignature(selection, details, certificate);
  await saveSigningPreference(selection, details);
  assert.deepEqual(await readSigningPreference(preferencePath, bundleId), saved);
  assert.equal((await fs.stat(preferencePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(preferencePath))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(preferencePath)), ['signing.json']);
});

test('a corrupt or differently scoped pin stops instead of selecting another certificate', async t => {
  const { options } = await fixture(t, { preference: { ...saved, bundleId: 'another.app' } });
  await assert.rejects(resolveSigningIdentity(options), /저장된 서명 설정/);
});

test('a broadly readable pin or symlink is rejected', async t => {
  const { options, preferencePath } = await fixture(t, { preference: saved });
  await fs.chmod(preferencePath, 0o644);
  await assert.rejects(resolveSigningIdentity(options), /권한 600/);
  await fs.rename(preferencePath, `${preferencePath}.target`);
  await fs.symlink(`${preferencePath}.target`, preferencePath);
  await assert.rejects(resolveSigningIdentity(options), { code: 'ELOOP' });
});
