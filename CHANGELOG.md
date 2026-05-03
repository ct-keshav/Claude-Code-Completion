# Changelog

All notable changes to **Claude Inline Completions** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Initial release

### Added
- Inline ghost-text completions backed by the Claude CLI subscription (no API key required).
- **Speculative prefetch** on trigger characters (punctuation/whitespace boundaries) — background CLI runs land in the cache before VS Code's debounce fires.
- **Prefix-shift LRU cache** — typing into a suggested completion produces sub-5ms hits per keystroke (base entries 60s TTL; derived entries 10s).
- **Single-line vs multi-line completion modes** — detected from cursor context; single-line uses tighter output cap and stops at the first newline.
- **Word-at-a-time / line-at-a-time accept** — `Cmd+→` / `Ctrl+→` for next word, `Cmd+↓` / `Ctrl+↓` for next line.
- **Fast-mode env vars** — extension passes `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `_CLAUDE_MDS`, `_BACKGROUND_TASKS`, `_THINKING`, `_ADAPTIVE_THINKING`, `_NONESSENTIAL_TRAFFIC`, and `SKIP_PROMPT_HISTORY` to every CLI spawn. Roughly halves per-request startup cost without breaking OAuth.
- **Pre-resolved cliPath** — startup resolves `"claude"` → absolute path once; spawn skips PATH lookup on every subsequent call.
- **Slim spawn env** — explicit allowlist of relevant env vars instead of full `process.env` copy.
- **Retrigger on prefetch landing** — when a prefetch finishes and the cursor is still in place, programmatically re-show the suggestion (the "Cursor magic").
- Streaming early-exit on narration / complete logical units / first newline (single-line mode).
- Single-flight cancellation: typing past a pending request kills the subprocess (SIGTERM → SIGKILL after 200ms).
- Smart prefetch coalescing: ≤8-char prefix extension keeps the in-flight prefetch instead of killing/respawning.
- Optional IntelliSense list integration (off by default).
- Skip heuristics: active selection, mid-identifier cursor, recent deletion, disabled language.
- Status bar item with ready / thinking / error / disabled / signed-out states.
- Commands: toggle, trigger now, clear cache, open logs, sign in.
- Configurable per-language activation, model, debounce, context windows, output cap.
- Sign-in flow that opens an integrated terminal and runs the CLI.

### Security
- `claude.completions.cliPath` only honored from User (global) settings; workspace overrides ignored with a console warning.
- POSIX-quoted `cliPath` in `signInFlow` to prevent shell injection.
