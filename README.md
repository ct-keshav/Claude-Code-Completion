# Claude Inline Completions

Cursor-style AI autocompletion for VS Code, powered by your already-authenticated `claude` CLI. **No Anthropic API key required** — uses your existing Claude Pro/Max subscription via the CLI's OAuth login.

![demo](docs/demo.gif)

## Why this exists

Anthropic's official editor integrations require an API key. If you have a Claude Pro/Max subscription, you've already authenticated via the `claude` CLI — but every SDK and `--bare` mode forces you back to API-key auth. This extension takes the only path that reuses your CLI login: spawning `claude` itself as a subprocess. With aggressive latency mitigation (debounce, single-flight, streaming early-exit, LRU cache), the spawn cost stays out of your way.

## Features

- **Inline ghost-text suggestions** — Cursor-style autocomplete in the editor.
- **Optional IntelliSense list integration** — surface Claude completions in the standard suggestion list (off by default; one CLI call per request).
- **Streaming with early exit** — kills the subprocess as soon as we have enough, or as soon as the model starts narrating instead of completing.
- **LRU cache** — repeated cursor positions resolve instantly.
- **Cancellation** — typing past a pending request cancels it cleanly.
- **Battery saver** — bumps debounce and disables the IntelliSense path when on battery (configurable).
- **Status bar feedback** — at-a-glance state: ready / thinking / error / disabled / signed-out.

## Requirements

1. **Claude CLI installed and on `PATH`** (or set `claude.completions.cliPath` to its absolute path).
   Install: <https://docs.claude.com/en/docs/claude-code/quickstart>
2. **Logged in via `claude`** — run `claude` once interactively and complete the OAuth flow.

You do **not** need an `ANTHROPIC_API_KEY`.

## Quick start

1. Install the extension.
2. Run **Claude: Sign In to Claude** (if you haven't already logged in via `claude`).
3. Start typing in any supported language. Inline ghost text appears after a 400ms debounce.
4. Press `Tab` to accept; `Esc` to dismiss.

Manual trigger: `Ctrl+Alt+\` (configurable).

## Settings

| Setting | Default | Description |
|---|---|---|
| `claude.completions.enabled` | `true` | Master switch. |
| `claude.completions.cliPath` | `"claude"` | Path to the Claude CLI. |
| `claude.completions.model` | `"claude-haiku-4-5-20251001"` | Haiku 4.5 — fastest option for completions. |
| `claude.completions.debounceMs` | `400` | Wait after last keystroke before requesting. |
| `claude.completions.maxPrefixChars` | `4000` | Prefix context window (chars). |
| `claude.completions.maxSuffixChars` | `1000` | Suffix context window (chars). |
| `claude.completions.maxOutputTokens` | `256` | Soft cap on completion length. |
| `claude.completions.languages` | (popular set) | Languages where completions activate. |
| `claude.completions.enableInline` | `true` | Inline ghost text. |
| `claude.completions.enableIntellisense` | `false` | Also show in IntelliSense list. |
| `claude.completions.batterySaver` | `true` | Slow down on battery. |

## Commands

- **Claude: Toggle Inline Completions** — flip enabled on/off.
- **Claude: Trigger Completion Now** (`Ctrl+Alt+\`) — force a completion at the cursor.
- **Claude: Clear Completion Cache** — drop the LRU cache (useful after big edits).
- **Claude: Open Logs** — show the structured log + latency telemetry.
- **Claude: Sign In to Claude** — opens an integrated terminal and runs the CLI for first-time login.

## Performance

The extension targets:
- **Cached p50 < 5ms** — cache hit, no spawn.
- **First-token p50 < 1.2s** — uncached.
- **Full completion p50 < 2s** — depends on response length.

Latency telemetry is logged to the **Claude Inline Completions** output channel (`Claude: Open Logs`).

## Troubleshooting

**"Claude CLI not found"** — set `claude.completions.cliPath` to the absolute path of `claude` (find it with `which claude` or `where claude`).

**"Claude is not signed in"** — run `claude` in a terminal and complete the OAuth login. Then reload the window.

**Completions are slow / not appearing** — open the logs (`Claude: Open Logs`) and look for `cli.run` metrics. First-token latency over 3s usually means the CLI is loading large CLAUDE.md files or hooks; try setting `claude.completions.cliPath` to invoke `claude` from a directory without project-level configuration.

**Completions look like prose, not code** — the post-processor strips most narration, but if you see it consistently, please file an issue with the raw output (visible in the logs).

## Architecture

```
keystroke → InlineCompletionItemProvider → skipHeuristics → cache lookup
        → debounce(400ms) → single-flight gate → ClaudeCli.run()
        → spawn `claude -p ... --output-format stream-json --verbose --include-partial-messages`
        → streamParser → completionCleaner → cache write → InlineCompletionList
```

Cancellation flows through an `AbortController` that calls `child.kill('SIGTERM')` (then `SIGKILL` after 200ms) when VS Code's `CancellationToken` fires or a newer request arrives.

See [`src/`](src/) for the implementation. Each module has a single responsibility:

- `cliClient.ts` — subprocess wrapper, the heart of latency control.
- `streamParser.ts` — pure NDJSON parser.
- `promptBuilder.ts` — FIM-style prompt assembly.
- `completionCleaner.ts` — strips fences, narration, suffix-overlap.
- `cache.ts` — LRU keyed by hashed prefix/suffix/model/mode.
- `skipHeuristics.ts` — early bailouts to avoid spawning needlessly.
- `inlineProvider.ts` — VS Code integration glue.

## Privacy

Your code is sent to Anthropic via your `claude` CLI subscription, subject to Anthropic's [usage policies](https://www.anthropic.com/legal/usage-policy). This extension does not send anything to any other server. Telemetry is local-only (the **Claude: Open Logs** output channel).

## Development

```bash
npm install
npm run watch        # esbuild watch mode
# In VS Code: F5 to launch the Extension Development Host
npm test             # unit + integration tests (uses fixtures/mock-claude.js)
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
