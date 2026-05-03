# Changelog

All notable changes to **Claude Inline Completions** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Initial release

### Added
- Inline ghost-text completions backed by the Claude CLI subscription (no API key required).
- Optional IntelliSense list integration (off by default).
- LRU completion cache (100 entries, 60s TTL).
- Streaming early-exit on narration / complete logical units.
- Single-flight cancellation: typing past a pending request kills the subprocess.
- Debounce (400ms default; battery-saver bumps to 1200ms on battery).
- Skip heuristics: cursor in the middle of an identifier, active selection, last edit was a deletion, etc.
- Status bar item with ready / thinking / error / disabled / signed-out states.
- Commands: toggle, trigger now, clear cache, open logs, sign in.
- Configurable per-language activation, model, debounce, context windows, output cap.
- Sign-in flow that opens an integrated terminal and runs the CLI.
