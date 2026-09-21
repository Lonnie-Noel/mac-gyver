import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const minimumNodeVersion = '22.12.0';

export function supportsNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

export function requireNodeVersion(version = process.versions.node) {
  if (!supportsNodeVersion(version)) {
    throw new Error(`Node.js ${minimumNodeVersion} 이상이 필요합니다. 현재: ${version}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { requireNodeVersion(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
