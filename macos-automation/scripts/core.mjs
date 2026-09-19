import path from 'node:path';

export const selectors = Object.freeze({
  edit: { identifier: 'IPXToolbarItemIDToggleEdit' },
  tools: { role: 'AXRadioButton', description: '도구' },
  reframe: { role: 'AXButton', title: '프레임 재설정' },
  save: { identifier: 'IPXEditModalSaveChanges' },
  cancel: { identifier: 'IPXEditModalCancelChanges' },
  done: { identifier: 'IPXToolbarItemIDToggleDoneEdit' },
});
export function matches(node, selector) { return Object.entries(selector).every(([key, value]) => node[key] === value); }
export function uniqueNode(snapshot, selector, { enabled = true } = {}) {
  const nodes = (snapshot.nodes ?? []).filter(node => matches(node, selector) && (!enabled || node.enabled === true));
  if (nodes.length !== 1) throw new Error(`UI 요소가 유일하지 않습니다: ${JSON.stringify(selector)} (${nodes.length})`);
  return nodes[0];
}
export function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
}
export function sameRect(a, b) { return validRect(a) && validRect(b) && ['x','y','width','height'].every(key => Math.abs(a[key] - b[key]) <= 1); }
export function readUI(snapshot) {
  if (!snapshot || snapshot.truncated || !Array.isArray(snapshot.nodes) || !validRect(snapshot.window?.rect)) throw new Error('완전한 사진 앱 UI 정보가 필요합니다.');
  const has = selector => snapshot.nodes.some(node => matches(node, selector) && node.enabled === true);
  const text = snapshot.nodes.map(n => [n.title,n.description,typeof n.value === 'string' ? n.value : ''].join(' ')).join('\n');
  const modal = snapshot.nodes.some(node => matches(node, selectors.cancel));
  const busy = snapshot.nodes.some(n => n.role === 'AXProgressIndicator') || /준비 중|생성 중|처리 중|재생성 중/.test(text);
  const alert = snapshot.nodes.some(n => n.role === 'AXSheet' || n.subrole === 'AXDialog' || n.subrole === 'AXSystemDialog');
  return { snapshot, text, modal, busy, alert, viewer: has(selectors.edit) && !modal && !has(selectors.done),
    editing: has(selectors.done) && !modal, tools: has(selectors.reframe) && !modal,
    reframeReady: modal && !busy && /드래그하여 시점|드래그.*조절/.test(text),
    dragged: modal && !busy && has(selectors.reframe),
    generated: modal && !busy && has(selectors.save),
  };
}
export function photoFrame(snapshot, width, height) {
  if (![width,height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('사진 픽셀 크기가 필요합니다.');
  const node = uniqueNode(snapshot, { identifier: 'IPXCanvasItemView' }, { enabled: false });
  const box = node.rect;
  if (!validRect(box) || !validRect(snapshot.window?.rect)) throw new Error('사진 표시 영역을 읽지 못했습니다.');
  const scale = Math.min(box.width / width, box.height / height);
  const fitted = { x: box.x + (box.width - width * scale) / 2, y: box.y + (box.height - height * scale) / 2, width: width * scale, height: height * scale };
  const window = snapshot.window.rect;
  if (fitted.x < window.x - 1 || fitted.y < window.y - 1 || fitted.x + fitted.width > window.x + window.width + 1 || fitted.y + fitted.height > window.y + window.height + 1) throw new Error('사진 영역이 창 밖에 있습니다.');
  return fitted;
}
export function dragGeometry(frame, radiusFactor = 0.5) {
  if (!validRect(frame) || !Number.isFinite(radiusFactor) || radiusFactor <= 0 || radiusFactor > 0.65) throw new Error('드래그 반지름 설정이 잘못됐습니다.');
  const distance = Math.min(frame.width, frame.height) * radiusFactor;
  const offset = distance / Math.sqrt(2);
  const from = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const to = { x: from.x - offset, y: from.y + offset };
  if (Math.min(frame.width,frame.height) < 150) throw new Error('사진 표시 영역이 너무 작습니다.');
  return { from, to, distance, allowedRect: frame };
}
export function rotateItems(items, selectedID) {
  if (!Array.isArray(items) || !items.length || new Set(items.map(i=>i.id)).size !== items.length || items.some(i=>typeof i.id !== 'string' || !i.id || typeof i.filename !== 'string')) throw new Error('앨범의 사진 ID 목록이 없거나 중복됩니다.');
  const index = items.findIndex(item => item.id === selectedID);
  if (index < 0) throw new Error('열린 사진이 선택한 앨범에 없습니다.');
  return [...items.slice(index),...items.slice(0,index)];
}
export function outputStem(filename, used = new Set()) {
  const ext = path.extname(filename);
  let base = (ext ? filename.slice(0, -ext.length) : filename).normalize('NFC')
    .replace(/[\\/\x00-\x1f\x7f:*?"<>|\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '');
  if (!base) throw new Error('파일 이름을 안전하게 만들 수 없습니다.');
  while (Buffer.byteLength(base) > 140) base = [...base].slice(0,-1).join('');
  let name=base, number=2;
  while (used.has(name.toLocaleLowerCase('en-US'))) name = `${base}-${String(number++).padStart(3,'0')}`;
  used.add(name.toLocaleLowerCase('en-US'));
  return name;
}
export function verifyIdentity(baseline, state, { restored = false } = {}) {
  for (const key of ['assetId','originalFilename','originalSHA256']) if (!baseline[key] || state[key] !== baseline[key]) throw new Error(`사진 식별 검증 실패: ${key}`);
  if (restored && (state.hasAdjustments !== false || state.currentSHA256 !== baseline.currentSHA256)) throw new Error('복원된 사진이 편집 전 이미지와 다릅니다.');
}
export function validateConfig(config) {
  for (const [key,min,max] of [['minimumGenerationSeconds',25,600],['generationTimeoutSeconds',25,1800],['dragRadiusFactor',0.05,0.65],['dragDurationMs',300,5000],['pollIntervalMs',200,5000]]) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) throw new Error(`잘못된 설정: ${key}`);
  }
  if (config.generationTimeoutSeconds < config.minimumGenerationSeconds) throw new Error('생성 시간제한은 최소 대기보다 길어야 합니다.');
  if (config.albumId !== null && (typeof config.albumId !== 'string' || !config.albumId.trim())) throw new Error('albumId는 비어 있지 않은 ID 또는 null이어야 합니다.');
  return config;
}
