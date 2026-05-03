import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser, classify } from '../../streamParser';

test('classify: text_delta', () => {
  const ev = classify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' }
    }
  });
  assert.equal(ev.kind, 'text');
  if (ev.kind === 'text') assert.equal(ev.text, 'hello');
});

test('classify: system init', () => {
  const ev = classify({ type: 'system', subtype: 'init' });
  assert.equal(ev.kind, 'init');
});

test('classify: result error', () => {
  const ev = classify({ type: 'result', is_error: true, error: 'boom' });
  assert.equal(ev.kind, 'error');
});

test('classify: assistant envelope ignored to avoid double-counting partial deltas', () => {
  const ev = classify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'abc' }] }
  });
  assert.equal(ev.kind, 'unknown');
});

test('StreamParser: handles split lines across feeds', () => {
  const p = new StreamParser();
  const a = p.feed('{"type":"system","subtype":"init"}\n{"type":"stream_event","event":{"ty');
  const b = p.feed('pe":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'init');
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'text');
  if (b[0].kind === 'text') assert.equal(b[0].text, 'hi');
});

test('StreamParser: garbage line classified as unknown', () => {
  const p = new StreamParser();
  const events = p.feed('not json at all\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'unknown');
});

test('StreamParser: trailing partial line buffered until newline', () => {
  const p = new StreamParser();
  assert.equal(p.feed('{"type":"system",').length, 0);
  assert.equal(p.feed('"subtype":"init"}\n').length, 1);
});
