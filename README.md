# Claude Inline Completions

Cursor-style AI autocompletion for VS Code, powered by your already-authenticated `claude` CLI. **No Anthropic API key required** — uses your existing Claude Pro/Max subscription via the CLI's OAuth login.

## Why this exists

Anthropic's official editor integrations require an API key. If you have a Claude Pro/Max subscription, you've already authenticated via the `claude` CLI — but every SDK and `--bare` mode forces you back to API-key auth. This extension takes the only path that reuses your CLI login: spawning `claude` itself as a subprocess. With aggressive latency mitigation (speculative prefetch, prefix-shift cache, streaming early-exit, fast-mode env vars), the spawn cost stays out of your way.

## Features

- **Inline ghost-text suggestions** — Cursor-style autocomplete in the editor.
- **Speculative prefetch** — when you type a punctuation/whitespace boundary, a background CLI request fires immediately. By the time you pause, the suggestion is already cached.
- **Prefix-shift cache** — typing into a suggested completion produces sub-5ms cache hits per keystroke.
- **Single-line vs multi-line modes** — detected from cursor context; single-line uses tighter output cap and stops at the first newline.
- **Word-at-a-time accept** — `Cmd+→` / `Ctrl+→` accepts one identifier; `Cmd+↓` / `Ctrl+↓` accepts one line; `Tab` accepts the whole suggestion.
- **Optional IntelliSense list integration** — surface Claude completions in the standard suggestion list (off by default; one CLI call per request).
- **Streaming with early exit** — kills the subprocess as soon as we have enough, or as soon as the model starts narrating instead of completing.
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
3. Start typing in any supported language. Inline ghost text appears after a 250ms debounce.
4. Press `Tab` to accept; `Esc` to dismiss.

Manual trigger: `Ctrl+Alt+\` (configurable).

## Keybindings

| Action | macOS | Windows / Linux |
|---|---|---|
| Accept whole suggestion | `Tab` | `Tab` |
| Accept next word | `Cmd+→` | `Ctrl+→` |
| Accept next line | `Cmd+↓` | `Ctrl+↓` |
| Force a completion | `Ctrl+Alt+\` | `Ctrl+Alt+\` |
| Dismiss | `Esc` | `Esc` |

(Word/line bindings only fire when an inline suggestion is visible — they don't conflict with normal cursor movement.)

## Settings

| Setting | Default | Description |
|---|---|---|
| `claude.completions.enabled` | `true` | Master switch. |
| `claude.completions.cliPath` | `"claude"` | Path to the Claude CLI. Resolved via `$PATH` if not absolute. **Only honored from User settings** — workspace overrides ignored for security. |
| `claude.completions.model` | `"claude-sonnet-4-6"` | Model passed to the CLI via `--model`. Try `claude-haiku-4-5-20251001` for slightly faster short completions. |
| `claude.completions.debounceMs` | `250` | Wait after last keystroke before requesting. |
| `claude.completions.maxPrefixChars` | `1500` | Prefix context window (chars). Smaller = faster first token. |
| `claude.completions.maxSuffixChars` | `400` | Suffix context window (chars). Smaller = faster first token. |
| `claude.completions.maxOutputTokens` | `128` | Soft cap on completion length. Lower = faster cutoff. |
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

Realistic latency depends heavily on whether Anthropic's prompt cache is warm for your prefix:

| Scenario | Latency |
|---|---|
| Cached (exact same cursor again) | <5ms |
| Prefix-shift cache (typing into suggestion) | <5ms per keystroke |
| Prefetch lands during your pause | 0ms perceived |
| Warm steady-state request | ~1.3-2.5s |
| Cold first request after long idle | ~4-5s |

The extension passes a set of `CLAUDE_CODE_DISABLE_*` env vars to every CLI spawn (auto-memory, claude.md auto-discovery, background tasks, internal "thinking" tokens, prompt history) which roughly halves the per-request CLI startup cost without breaking OAuth. These are layered automatically; user-set values from the parent environment take precedence if you want to override.

Latency telemetry is logged to the **Claude Inline Completions** output channel (`Claude: Open Logs`).

## Troubleshooting

**"Claude CLI not found"** — set `claude.completions.cliPath` to the absolute path of `claude` (find it with `which claude` or `where claude`).

**"Claude is not signed in"** — run `claude` in a terminal and complete the OAuth login. Then reload the window.

**Completions are slow / not appearing** — open the logs (`Claude: Open Logs`) and look for `cli.run` metrics. First-token latency over 3s usually means the CLI is loading large CLAUDE.md files or hooks; the extension already disables most of these via env vars, but a project-level `.claude/` directory may still be loaded.

**Completions look like prose, not code** — the post-processor strips most narration, but if you see it consistently, please file an issue with the raw output (visible in the logs).

**Completions are inaccurate after a few keystrokes** — clear the cache via **Claude: Clear Completion Cache**. The prefix-shift cache assumes you're typing exactly what was suggested; small deviations should fall through correctly, but a stuck cache can be cleared manually.

## Architecture

```
keystroke
  ├─ trigger char detected → speculative prefetch fires (background CLI)
  └─ VS Code requests inline suggestion
        ├─ language gate
        ├─ exact-context cache hit?  → serve instantly
        ├─ skip heuristics (selection / mid-identifier / battery saver)
        ├─ adopt in-flight prefetch with same key
        └─ debounce + spawn `claude -p ... stream-json` with fast-mode env
              ├─ streamParser → onText (narration guard, single-line guard,
              │                          complete-unit detection)
              ├─ completionCleaner (fences, narration, suffix overlap)
              └─ cache.setWithShifts (base + N derived entries for typing-into-suggestion)
```

Cancellation flows through an `AbortController` that calls `child.kill('SIGTERM')` (then `SIGKILL` after 200ms) when VS Code's `CancellationToken` fires or a newer request arrives. Prefetches coalesce when the user is typing forward through trigger chars (≤8-char prefix extension reuses the in-flight prefetch).

See [`src/`](src/) for the implementation. Each module has a single responsibility:

- `cliClient.ts` — subprocess wrapper, fast-mode env vars, the heart of latency control.
- `streamParser.ts` — pure NDJSON parser.
- `promptBuilder.ts` — FIM-style prompt assembly + single/multi-line mode detection.
- `completionCleaner.ts` — strips fences, narration, suffix-overlap.
- `cache.ts` — LRU keyed by hashed prefix/suffix/model/mode/shape, with prefix-shift derived entries.
- `skipHeuristics.ts` — early bailouts to avoid spawning needlessly.
- `inlineProvider.ts` — VS Code integration glue, prefetch orchestration, retrigger.
- `auth.ts` — CLI presence + auth probe + sign-in flow.
- `resolvedCli.ts` — process-wide cache for the absolute CLI path.

## Privacy

Your code is sent to Anthropic via your `claude` CLI subscription, subject to Anthropic's [usage policies](https://www.anthropic.com/legal/usage-policy). This extension does not send anything to any other server. Telemetry is local-only (the **Claude: Open Logs** output channel).

## Security

`claude.completions.cliPath` is only honored from User (global) settings. A malicious workspace shipping `.vscode/settings.json` with a redirected CLI path is ignored with a console warning.

The `signInFlow` POSIX-quotes `cliPath` before sending to the integrated terminal, eliminating shell injection risk.

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
