import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';

const PHOTO_EXTENSION = /\.(heic|heif|jpe?g|png|dng|tiff?|avif)$/iu;
const EVIDENCE_KEYS = ['beforeCapture', 'afterCapture', 'beforeSource', 'afterSource', 'generation'];
const canonical = (value) => value.normalize('NFKC').toLowerCase();
const padded = (value, width) => String(value).padStart(width, '0');

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function originalName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An actual original filename is required');
  const filename = value.normalize('NFC').trim();
  if (/[\\/\u0000-\u001f\u007f]/u.test(filename) || filename === '.' || filename === '..') {
    throw new Error('Original filename must be a filename, not a path');
  }
  let basename = filename.replace(PHOTO_EXTENSION, '').replace(/[:*?"<>|\u202a-\u202e\u2066-\u2069]/gu, '_');
  basename = basename.replace(/^[. ]+|[. ]+$/gu, '');
  if (!basename) throw new Error('Original filename has no usable basename');
  // Leave room for collision suffixes and the longest evidence suffix on APFS.
  if (Buffer.byteLength(basename, 'utf8') > 140) {
    const hash = createHash('sha256').update(basename).digest('hex').slice(0, 10);
    let shortened = '';
    for (const character of basename) {
      if (Buffer.byteLength(shortened + character, 'utf8') > 128) break;
      shortened += character;
    }
    basename = `${shortened}-${hash}`;
  }
  return { originalFilename: filename, basename };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containedPath(runDir, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')
    || path.isAbsolute(relative) || /^[a-z]:/iu.test(relative) || relative.split('/').includes('..')) {
    throw new Error('Artifact path must stay inside the run directory');
  }
  const root = path.resolve(runDir);
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('Artifact path escapes run directory');
  return target;
}

function pathsForBase(outputBase, originalFilename) {
  return {
    outputBase,
    originalFilename,
    beforeCapture: `${outputBase}-preview-capture.png`,
    afterCapture: `${outputBase}-result-capture.png`,
    resultImage: `${outputBase}-result.jpg`,
    beforeSource: `.metadata/${outputBase}-preview-source.xml`,
    afterSource: `.metadata/${outputBase}-result-source.xml`,
    generation: `.metadata/${outputBase}-generation.json`,
  };
}

/** Plan relative filenames without reading or changing the filesystem.
 * existingNames contains relative paths, including filenames in .metadata/.
 */
export function makeCapturePaths(runDir, { originalFilename, index, attempt = 1, existingNames = [] } = {}) {
  positiveInteger(index, 'index');
  positiveInteger(attempt, 'attempt');
  const original = originalName(originalFilename);
  const occupied = new Set(Array.from(existingNames, canonical));
  const retry = attempt > 1 ? `-attempt-${padded(attempt, 2)}` : '';
  const candidates = [original.basename + retry, `${original.basename}-photo-${padded(index, 3)}${retry}`];
  for (let serial = Math.max(attempt, 2); serial < Math.max(attempt, 2) + 10_000; serial++) {
    candidates.push(`${original.basename}-photo-${padded(index, 3)}-attempt-${padded(serial, 2)}`);
  }
  for (const outputBase of new Set(candidates)) {
    const planned = pathsForBase(outputBase, original.originalFilename);
    for (const key of EVIDENCE_KEYS) containedPath(runDir, planned[key]);
    if ([...EVIDENCE_KEYS, 'resultImage'].every((key) => !occupied.has(canonical(planned[key])))) return planned;
  }
  throw new Error('Too many filename collisions in this run directory');
}

async function ensureRealDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence directory must be a real directory');
}

async function existingNames(runDir) {
  const names = await readdir(runDir);
  const metadata = path.join(runDir, '.metadata');
  if (existsSync(metadata)) {
    const info = await lstat(metadata);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence directory must be a real directory');
    names.push(...(await readdir(metadata)).map((name) => `.metadata/${name}`));
  }
  return names;
}

/** Reserve a unique set of filenames. Empty files are owned by this capture;
 * callers replace their contents, never any previously existing capture.
 * The retained reservation also prevents concurrent case/Unicode collisions.
 */
export async function reserveCapturePaths(runDir, options) {
  makeCapturePaths(runDir, options); // Reject missing/unsafe original names before creating anything.
  await mkdir(runDir, { recursive: true });
  await ensureRealDirectory(path.join(runDir, '.metadata'));
  const reservationDir = path.join(runDir, '.metadata', '.capture-reservations');
  await ensureRealDirectory(reservationDir);
  const occupied = new Set([...(options.existingNames ?? []), ...await existingNames(runDir)]);
  for (let tries = 0; tries < 10_000; tries++) {
    const planned = makeCapturePaths(runDir, { ...options, existingNames: occupied });
    const key = createHash('sha256').update(canonical(planned.outputBase)).digest('hex');
    const reservation = path.join(reservationDir, `${key}.json`);
    let lock;
    try {
      lock = await open(reservation, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      for (const field of EVIDENCE_KEYS) occupied.add(planned[field]);
      continue;
    }
    const created = [];
    try {
      await lock.writeFile(`${JSON.stringify({ index: options.index, attempt: options.attempt ?? 1, ...planned }, null, 2)}\n`);
      for (const field of EVIDENCE_KEYS) {
        const file = containedPath(runDir, planned[field]);
        const handle = await open(file, 'wx');
        created.push(file);
        await handle.close();
      }
      return planned;
    } catch (error) {
      await Promise.all(created.map((file) => unlink(file)));
      await unlink(reservation);
      if (error.code !== 'EEXIST') throw error;
      for (const field of EVIDENCE_KEYS) occupied.add(planned[field]);
    } finally {
      await lock.close();
    }
  }
  throw new Error('Unable to reserve unique capture filenames');
}

function checkExistingParents(runDir, target) {
  const root = path.resolve(runDir);
  if (!existsSync(root)) return;
  const actualRoot = realpathSync(root);
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
  const actualAncestor = realpathSync(ancestor);
  if (actualAncestor !== actualRoot && !inside(actualRoot, actualAncestor)) {
    throw new Error('Artifact symlink escapes run directory');
  }
}

/** Resolve evidence from new flat entries or existing per-photo folder entries.
 * Returns absolute paths. Unsafe paths and symlinks outside runDir are rejected.
 */
export function evidencePaths(runDir, entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Capture manifest entry is required');
  let relative;
  if (['beforeCapture', 'afterCapture', 'beforeSource', 'afterSource'].some((key) => entry[key] !== undefined)) {
    relative = Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, entry[key]]));
  } else {
    containedPath(runDir, entry.before);
    containedPath(runDir, entry.after);
    relative = {
      beforeCapture: path.posix.join(entry.before, 'screen.png'),
      afterCapture: path.posix.join(entry.after, 'screen.png'),
      beforeSource: path.posix.join(entry.before, 'source.xml'),
      afterSource: path.posix.join(entry.after, 'source.xml'),
      generation: entry.generation ?? path.posix.join(entry.before, '..', 'generation.json'),
    };
  }
  return Object.fromEntries(EVIDENCE_KEYS.map((key) => {
    const file = containedPath(runDir, relative[key]);
    checkExistingParents(runDir, file);
    return [key, file];
  }));
}
