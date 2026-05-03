import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCompletion,
  looksLikeNarration,
  stripSuffixOverlap,
  looksLikeCompleteUnit
} from '../../completionCleaner';

test('looksLikeNarration: catches "Here is"', () => {
  assert.equal(looksLikeNarration('Here is the completion'), true);
});

test('looksLikeNarration: catches markdown heading', () => {
  assert.equal(looksLikeNarration('# Section'), true);
});

test('looksLikeNarration: shebang is not narration', () => {
  assert.equal(looksLikeNarration('#!/usr/bin/env node'), false);
});

test('looksLikeNarration: actual code is not narration', () => {
  assert.equal(looksLikeNarration('function add(a, b) {'), false);
});

test('cleanCompletion: strips fenced code block', () => {
  const out = cleanCompletion({
    raw: '```js\nfunction add(a, b) {\n  return a + b;\n}\n```',
    followingText: ''
  });
  assert.match(out, /^function add/);
  assert.doesNotMatch(out, /```/);
});

test('cleanCompletion: strips leading narration line', () => {
  const out = cleanCompletion({
    raw: 'Here is the completion:\nfunction add() {}',
    followingText: ''
  });
  assert.equal(out, 'function add() {}');
});

test('cleanCompletion: handles empty input', () => {
  assert.equal(cleanCompletion({ raw: '', followingText: '' }), '');
});

test('stripSuffixOverlap: removes overlap', () => {
  const r = stripSuffixOverlap('return a + b;\n}', '\n}');
  assert.equal(r, 'return a + b;');
});

test('stripSuffixOverlap: no overlap returns original', () => {
  const r = stripSuffixOverlap('foo', 'bar');
  assert.equal(r, 'foo');
});

test('looksLikeCompleteUnit: balanced braces ending with }', () => {
  assert.equal(looksLikeCompleteUnit('function f() {\n  return 1;\n}'), true);
});

test('looksLikeCompleteUnit: unbalanced returns false', () => {
  assert.equal(looksLikeCompleteUnit('function f() {\n  return 1;'), false);
});

test('looksLikeCompleteUnit: triple newlines triggers', () => {
  assert.equal(looksLikeCompleteUnit('return value;\n\n\nnext'), true);
});
