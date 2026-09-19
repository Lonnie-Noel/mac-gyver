import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOriginalFilename } from '../scripts/photo-filename.mjs';

const text = (label, extra = {}) => ({ type: 'XCUIElementTypeStaticText', visible: 'true', label, ...extra });
const state = (...visible) => ({ visible, nodes: visible });

test('reads an exact photo filename newly shown by the information panel', () => {
  for (const filename of ['IMG_1234.HEIC', 'filename.jpg', 'Portrait.jpeg', 'raw.dng', 'Trip.tiff', 'saved.avif']) {
    assert.equal(extractOriginalFilename(state(text('2026년 9월 19일')), state(text(filename))), filename);
  }
});

test('recognizes common camera basenames when Photos hides the extension', () => {
  for (const filename of ['IMG_1234', 'IMG_E1234', 'DSC_0001', 'PXL_20260919_123456789', 'PXL_20260919_123456789.MP']) {
    assert.equal(extractOriginalFilename(state(), state(text(filename))), filename);
  }
});

test('keeps Unicode filenames while deduplicating case and canonical normalization', () => {
  const filename = '여행 Café.JPG';
  const info = state(text(filename, { name: '여행 Cafe\u0301.jpg', value: '여행 CAFÉ.JPG' }));
  assert.equal(extractOriginalFilename(state(), info), filename);
});

test('duplicate filename attributes and repeated elements identify one file', () => {
  const info = state(text('IMG_1234.JPG', { value: 'IMG_1234.JPG', name: 'IMG_1234.JPG' }), text('img_1234.jpg'));
  assert.equal(extractOriginalFilename(state(), info), 'IMG_1234.JPG');
});

test('multiple distinct filename candidates stop instead of choosing arbitrarily', () => {
  assert.throws(() => extractOriginalFilename(state(), state(text('IMG_1234.JPG'), text('IMG_1235.JPG'))), /Ambiguous/u);
  assert.throws(() => extractOriginalFilename(state(), state(text('IMG_1234.JPG', { value: 'IMG_1235.JPG' }))), /Ambiguous/u);
});

test('paths and labelled or multiline strings are never treated as filenames', () => {
  for (const value of ['/DCIM/IMG_1234.JPG', '../IMG_1234.JPG', 'DCIM\\IMG_1234.JPG', 'Filename: IMG_1234.JPG', '사진\nIMG_1234.JPG', '...jpg']) {
    assert.equal(extractOriginalFilename(state(), state(text(value))), null);
  }
});

test('existing viewer captions and labels are excluded even if repeated in Info', () => {
  const before = state(text('IMG_1234.JPG'), { type: 'XCUIElementTypeButton', visible: 'true', name: 'Café.JPG' });
  const info = state(text('img_1234.jpg'), text('CAFE\u0301.jpg'), text('IMG_5678.HEIC'));
  assert.equal(extractOriginalFilename(before, info), 'IMG_5678.HEIC');
  assert.equal(extractOriginalFilename(before, state(text('IMG_1234.JPG'))), null);
});

test('only visible static text supplies a name, not buttons or hidden elements', () => {
  const info = { nodes: [
    { type: 'XCUIElementTypeButton', visible: 'true', label: 'IMG_1234.JPG' },
    text('IMG_5678.JPG', { visible: 'false' }),
  ] };
  assert.equal(extractOriginalFilename(state(), info), null);
});

test('dates, dimensions, custom extensionless names, and unknown extensions halt discovery', () => {
  for (const value of ['2026년 9월 19일', '2026-09-19', '20260919', '4032 × 3024', '가족 여행', '2026', 'archive.zip']) {
    assert.equal(extractOriginalFilename(state(), state(text(value))), null);
  }
  assert.throws(() => extractOriginalFilename(null, state(text('IMG_1234.JPG'))), /states are required/u);
});
