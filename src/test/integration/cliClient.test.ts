import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ClaudeCli } from '../../cliClient';

const MOCK_PATH = path.resolve(__dirname, '../fixtures/mock-claude.js');

// Ensure the mock is executable on POSIX so we can spawn it as cliPath.
try {
  fs.chmodSync(MOCK_PATH, 0o755);
} catch {
  // best-effort
}

test('cliClient: streams text and resolves on stop', async () => {
  const script = JSON.stringify({
    events: [
      { delay: 5, type: 'init' },
      { delay: 5, type: 'text', text: 'console.log(' },
      { delay: 5, type: 'text', text: '"hi");\n' },
      { delay: 5, type: 'stop' }
    ],
    exitCode: 0
  });
  let firstChunk = '';
  const run = ClaudeCli.run({
    cliPath: MOCK_PATH,
    model: 'mock',
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 256,
    env: { MOCK_CLAUDE_SCRIPT: script },
    onText: (text, _acc) => {
      if (!firstChunk) firstChunk = text;
    }
  });
  const result = await run.promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.killed, false);
  assert.equal(result.earlyExit, false);
  assert.equal(result.text, 'console.log("hi");\n');
  assert.ok(result.msFirstToken >= 0);
  assert.ok(firstChunk.length > 0);
});

test('cliClient: cancellation kills child', async () => {
  const script = JSON.stringify({
    events: [
      { delay: 5, type: 'init' },
      { delay: 5000, type: 'text', text: 'should-not-arrive' }
    ],
    exitCode: 0
  });
  const run = ClaudeCli.run({
    cliPath: MOCK_PATH,
    model: 'mock',
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 256,
    env: { MOCK_CLAUDE_SCRIPT: script }
  });
  setTimeout(() => run.cancel(), 50);
  const result = await run.promise;
  assert.equal(result.killed, true);
  assert.ok(!result.text.includes('should-not-arrive'));
});

test('cliClient: onText early-exit stops the stream', async () => {
  const script = JSON.stringify({
    events: [
      { delay: 5, type: 'init' },
      { delay: 5, type: 'text', text: 'STOP' },
      { delay: 5000, type: 'text', text: 'should-not-arrive' }
    ],
    exitCode: 0
  });
  const run = ClaudeCli.run({
    cliPath: MOCK_PATH,
    model: 'mock',
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 256,
    env: { MOCK_CLAUDE_SCRIPT: script },
    onText: (_text, accumulated) => accumulated.includes('STOP')
  });
  const result = await run.promise;
  assert.equal(result.earlyExit, true);
  assert.ok(result.text.includes('STOP'));
  assert.ok(!result.text.includes('should-not-arrive'));
});

test('cliClient: AbortSignal cancels run', async () => {
  const script = JSON.stringify({
    events: [
      { delay: 5, type: 'init' },
      { delay: 5000, type: 'text', text: 'wont-emit' }
    ],
    exitCode: 0
  });
  const ac = new AbortController();
  const run = ClaudeCli.run({
    cliPath: MOCK_PATH,
    model: 'mock',
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 256,
    env: { MOCK_CLAUDE_SCRIPT: script },
    signal: ac.signal
  });
  setTimeout(() => ac.abort(), 30);
  const result = await run.promise;
  assert.equal(result.killed, true);
});
