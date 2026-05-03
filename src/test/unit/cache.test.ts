import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionCache } from '../../cache';

const baseKey = {
  filename: 'a.ts',
  languageId: 'typescript',
  prefix: 'function f() {',
  suffix: '}',
  model: 'claude-sonnet-4-6',
  mode: 'inline' as const
};

test('cache: stores and retrieves', () => {
  const c = new CompletionCache(10, 60_000);
  c.set(baseKey, 'return 1;');
  assert.equal(c.get(baseKey), 'return 1;');
});

test('cache: misses on different prefix', () => {
  const c = new CompletionCache(10, 60_000);
  c.set(baseKey, 'return 1;');
  assert.equal(c.get({ ...baseKey, prefix: 'function g() {' }), undefined);
});

test('cache: respects TTL', async () => {
  const c = new CompletionCache(10, 5);
  c.set(baseKey, 'x');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.get(baseKey), undefined);
});

test('cache: evicts LRU past max size', () => {
  const c = new CompletionCache(2, 60_000);
  c.set({ ...baseKey, prefix: 'a' }, '1');
  c.set({ ...baseKey, prefix: 'b' }, '2');
  c.set({ ...baseKey, prefix: 'c' }, '3');
  assert.equal(c.get({ ...baseKey, prefix: 'a' }), undefined);
  assert.equal(c.get({ ...baseKey, prefix: 'b' }), '2');
  assert.equal(c.get({ ...baseKey, prefix: 'c' }), '3');
});

test('cache: keys differ per mode', () => {
  const c = new CompletionCache(10, 60_000);
  c.set({ ...baseKey, mode: 'inline' }, 'A');
  c.set({ ...baseKey, mode: 'intellisense' }, 'B');
  assert.equal(c.get({ ...baseKey, mode: 'inline' }), 'A');
  assert.equal(c.get({ ...baseKey, mode: 'intellisense' }), 'B');
});

test('cache: clear empties', () => {
  const c = new CompletionCache(10, 60_000);
  c.set(baseKey, 'x');
  c.clear();
  assert.equal(c.size(), 0);
});

test('cache: setWithShifts writes derived entries for typed-into-suggestion', () => {
  const c = new CompletionCache(100, 60_000);
  const value = 'a + b;';
  c.setWithShifts(baseKey, value);
  // Original cursor: full value.
  assert.equal(c.get(baseKey), value);
  // After typing 'a': we should hit ' + b;'.
  assert.equal(c.get({ ...baseKey, prefix: baseKey.prefix + 'a' }), ' + b;');
  // After typing 'a +': we should hit ' b;'.
  assert.equal(c.get({ ...baseKey, prefix: baseKey.prefix + 'a +' }), ' b;');
});

test('cache: setWithShifts respects maxShift bound', () => {
  const c = new CompletionCache(1000, 60_000);
  const value = 'x'.repeat(200);
  c.setWithShifts(baseKey, value, { maxShift: 10 });
  // Up to 10 shifts plus the original.
  assert.ok(c.size() <= 11);
});

test('cache: derived entries expire faster than base entries', async () => {
  const c = new CompletionCache(100, 60_000);
  c.setWithShifts(baseKey, 'a + b;', { maxShift: 5, derivedTtlMs: 5 });
  // Base entry should still be present; derived should expire quickly.
  assert.equal(c.get(baseKey), 'a + b;');
  await new Promise((r) => setTimeout(r, 20));
  // Derived entries are gone now.
  assert.equal(c.get({ ...baseKey, prefix: baseKey.prefix + 'a' }), undefined);
  // Base entry still alive (60s TTL).
  assert.equal(c.get(baseKey), 'a + b;');
});
