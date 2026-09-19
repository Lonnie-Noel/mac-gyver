const PHOTO_EXTENSION = /\.(?:heic|heif|jpeg|jpg|png|dng|tif|tiff|avif)$/iu;
const CAMERA_BASENAME = /^(?:IMG_E?\d{4,}(?:[_-][a-z0-9]+)*|DSC_\d{4,}(?:[_-][a-z0-9]+)*|PXL_\d{8}_\d{6,}(?:[._-][a-z0-9]+)*)$/iu;
const TEXT_ATTRIBUTES = ['label', 'value', 'name'];
const keyFor = (value) => value.normalize('NFC').toLowerCase();

function visibleNodes(state) {
  if (Array.isArray(state?.visible)) return state.visible;
  if (Array.isArray(state?.nodes)) return state.nodes.filter((node) => node.visible === 'true');
  throw new Error('Parsed before/info UI states are required to identify a filename');
}

function strings(node) {
  return TEXT_ATTRIBUTES.flatMap((attribute) => {
    const value = node?.[attribute];
    return typeof value === 'string' && value.trim() ? [value.normalize('NFC').trim()] : [];
  });
}

function acceptedFilename(value) {
  // An entire text value must be a filename. Do not extract a filename-shaped
  // substring from a path, caption, multiline description, or labelled sentence.
  if (/[\\/\u0000-\u001f\u007f:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  if (value === '.' || value === '..') return false;
  if (PHOTO_EXTENSION.test(value)) {
    return !/^[. ]*$/u.test(value.replace(PHOTO_EXTENSION, ''));
  }
  return CAMERA_BASENAME.test(value);
}

/** Read a newly revealed filename from Photos' information panel.
 * Both arguments use parseState's {visible, nodes} shape. This deliberately
 * ignores existing viewer text and accepts only new visible StaticText values.
 * Unrecognized custom names without an extension return null: callers must
 * halt and inspect the UI, never invent a name or silently use a photo index.
 * These recognition rules require a live UI check on a supported Photos version.
 */
export function extractOriginalFilename(beforeState, infoState) {
  const before = new Set(visibleNodes(beforeState).flatMap(strings).map(keyFor));
  const candidates = new Map();
  for (const node of visibleNodes(infoState)) {
    if (node.type !== 'XCUIElementTypeStaticText') continue;
    for (const value of strings(node)) {
      const key = keyFor(value);
      if (!before.has(key) && acceptedFilename(value) && !candidates.has(key)) candidates.set(key, value);
    }
  }
  if (candidates.size > 1) throw new Error('Ambiguous original filename in the photo information panel');
  return candidates.values().next().value ?? null;
}
