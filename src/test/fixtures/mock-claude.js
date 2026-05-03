#!/usr/bin/env node
/**
 * Drop-in mock for the `claude` CLI in tests. Reads scripted behavior from
 * the MOCK_CLAUDE_SCRIPT env var (a JSON document) and emits NDJSON to stdout.
 *
 * Script shape:
 *   {
 *     "events": [
 *       {"delay": 50, "type": "init"},
 *       {"delay": 30, "type": "text", "text": "function fizzbuzz"},
 *       {"delay": 30, "type": "text", "text": "(n) {\n"},
 *       {"delay": 0,  "type": "stop"}
 *     ],
 *     "exitCode": 0,
 *     "stderr": ""
 *   }
 *
 * If MOCK_CLAUDE_SCRIPT is not set, the mock emits a deterministic default
 * stream useful for smoke tests.
 */

'use strict';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('mock-claude 0.0.0\n');
  process.exit(0);
}

let script;
try {
  script = process.env.MOCK_CLAUDE_SCRIPT
    ? JSON.parse(process.env.MOCK_CLAUDE_SCRIPT)
    : {
        events: [
          { delay: 5, type: 'init' },
          { delay: 5, type: 'text', text: 'console.log("hello world");\n' },
          { delay: 5, type: 'stop' }
        ],
        exitCode: 0
      };
} catch (e) {
  process.stderr.write(`mock-claude: bad script JSON: ${e.message}\n`);
  process.exit(2);
}

function emit(line) {
  process.stdout.write(line + '\n');
}

function eventToLine(ev) {
  switch (ev.type) {
    case 'init':
      return JSON.stringify({ type: 'system', subtype: 'init', model: 'mock' });
    case 'text':
      return JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: ev.text }
        }
      });
    case 'stop':
      return JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_stop' }
      });
    case 'result':
      return JSON.stringify({ type: 'result', subtype: 'success', is_error: false });
    case 'raw':
      return ev.line;
    default:
      return JSON.stringify(ev);
  }
}

let cancelled = false;
process.on('SIGTERM', () => { cancelled = true; });
process.on('SIGINT', () => { cancelled = true; });

(async () => {
  for (const ev of script.events || []) {
    if (cancelled) break;
    if (ev.delay) await new Promise((r) => setTimeout(r, ev.delay));
    if (cancelled) break;
    emit(eventToLine(ev));
  }
  if (script.stderr) process.stderr.write(String(script.stderr));
  process.exit(script.exitCode ?? 0);
})();
