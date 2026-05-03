import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, computeWindows, trimToLineBoundary, detectMode } from '../../promptBuilder';

test('buildPrompt: places FILL_HERE at cursor', () => {
  const out = buildPrompt({
    prefix: 'function add(a, b) {\n  return ',
    suffix: '',
    languageId: 'javascript',
    filename: 'add.js'
  });
  assert.match(out.userPrompt, /<FILL_HERE>$/);
  assert.match(out.userPrompt, /function add/);
  assert.match(out.userPrompt, /Language: javascript/);
});

test('buildPrompt: places suffix after FILL_HERE', () => {
  const out = buildPrompt({
    prefix: 'abc',
    suffix: 'xyz',
    languageId: 'plaintext',
    filename: 'x.txt'
  });
  assert.match(out.userPrompt, /abc<FILL_HERE>xyz$/);
});

test('buildPrompt: respects explicit mode override', () => {
  const out = buildPrompt({
    prefix: 'const x = ',
    suffix: '',
    languageId: 'javascript',
    filename: 'x.js',
    mode: 'multi-line'
  });
  assert.equal(out.mode, 'multi-line');
});

test('computeWindows: trims at line boundaries', () => {
  const text = 'aaa\nbbb\nccc\nddd\n';
  const w = computeWindows(text, text.length, 8, 0);
  assert.ok(!w.prefix.startsWith('a'));
});

test('computeWindows: clamps offset', () => {
  const w = computeWindows('abc', 99, 100, 100);
  assert.equal(w.prefix, 'abc');
  assert.equal(w.suffix, '');
});

test('computeWindows: only allocates needed slice for huge documents', () => {
  // 1MB document, cursor in the middle — windows should be tiny.
  const big = 'x'.repeat(500_000) + '\nMARKER\n' + 'y'.repeat(500_000);
  const offset = 500_001 + 'MARKER\n'.length;
  const w = computeWindows(big, offset, 100, 100);
  assert.ok(w.prefix.length <= 100);
  assert.ok(w.suffix.length <= 100);
});

test('trimToLineBoundary: tail keeps recent lines', () => {
  const r = trimToLineBoundary('aaa\nbbb\nccc\n', 5, 'tail');
  assert.equal(r, 'ccc\n');
});

test('trimToLineBoundary: head keeps early lines', () => {
  const r = trimToLineBoundary('aaa\nbbb\nccc\n', 5, 'head');
  assert.equal(r, 'aaa\n');
});

test('trimToLineBoundary: short input returned as-is', () => {
  const r = trimToLineBoundary('abc', 100, 'tail');
  assert.equal(r, 'abc');
});

test('detectMode: empty current line → multi-line', () => {
  assert.equal(detectMode('function f() {\n  ', '\n}'), 'multi-line');
});

test('detectMode: prefix ends with { → multi-line', () => {
  assert.equal(detectMode('function f() {', '\n}'), 'multi-line');
});

test('detectMode: prefix ends with => → multi-line', () => {
  assert.equal(detectMode('const f = () =>', ''), 'multi-line');
});

test('detectMode: prefix ends with comma at end of line → multi-line', () => {
  assert.equal(detectMode('  foo: 1,', '\n  bar: 2'), 'multi-line');
});

test('detectMode: cursor mid-line with code after → single-line', () => {
  assert.equal(detectMode('const sum = a + ', 'b;\nconst other = 1;'), 'single-line');
});

test('detectMode: cursor end-of-line with code on line → single-line', () => {
  assert.equal(detectMode('console.log(', '\n}'), 'multi-line'); // ( is opener
  assert.equal(detectMode('console.log(x', ')'), 'single-line');
});

test('buildPrompt: single-line mode returns lower output cap', () => {
  const out = buildPrompt({
    prefix: 'const sum = a + ',
    suffix: 'b',
    languageId: 'javascript',
    filename: 'x.js'
  });
  assert.equal(out.mode, 'single-line');
  assert.ok(out.suggestedMaxOutputTokens <= 64);
});

test('buildPrompt: multi-line mode uses larger output cap', () => {
  const out = buildPrompt({
    prefix: 'function f() {\n  ',
    suffix: '',
    languageId: 'javascript',
    filename: 'x.js'
  });
  assert.equal(out.mode, 'multi-line');
  assert.ok(out.suggestedMaxOutputTokens > 64);
});
