# Developer Guide — Claude Inline Completions

A new-developer onboarding doc for this VS Code extension. Read this end-to-end and you should understand:
- what the extension does and how a single keystroke flows through it,
- which file owns which responsibility,
- how to build, run, debug, and test it,
- where the non-obvious latency tricks live.

For a user-facing description (settings, keybindings, install steps), read [`README.md`](../README.md). This doc is for contributors.

---

## 1. What the extension does

A Cursor-style inline-completion provider for VS Code that talks to Anthropic's hosted Claude models — but instead of using the Anthropic API (which requires a key), it spawns the user's locally-installed `claude` CLI as a subprocess and reuses the CLI's OAuth login.

That single architectural choice — spawn the CLI per request — drives most of the codebase. The CLI takes ~1–4s of startup overhead, so the extension is built around hiding that latency: prefetching, caching, streaming early-exit, prefix-shift cache hits, fast-mode env vars.

There are two completion surfaces:
- **Inline ghost text** (default, the primary surface) — `vscode.languages.registerInlineCompletionItemProvider`.
- **IntelliSense list** (opt-in) — `vscode.languages.registerCompletionItemProvider`.

---

## 2. Repository layout

```
.
├── src/
│   ├── extension.ts          # entry point: activate/deactivate, provider registration
│   ├── config.ts             # typed view over VS Code settings + onChange wiring
│   ├── commands.ts           # registers all "Claude: …" commands
│   ├── statusBar.ts          # status-bar item with ready/thinking/error/disabled/unauth states
│   ├── logger.ts             # output-channel logger (info/warn/error/debug/metric)
│   │
│   ├── inlineProvider.ts     # the inline-ghost-text provider (the meaty one)
│   ├── completionProvider.ts # the optional IntelliSense provider
│   │
│   ├── cliClient.ts          # spawns `claude`, slim env, fast-mode flags, cancellation
│   ├── streamParser.ts       # NDJSON parser for --output-format stream-json
│   ├── promptBuilder.ts      # FIM prompt assembly + single/multi-line mode detection
│   ├── completionCleaner.ts  # strip fences/narration, dedup overlap, complete-unit detection
│   ├── cache.ts              # LRU + prefix-shift derived entries
│   ├── skipHeuristics.ts     # cheap bailouts before spawning
│   │
│   ├── auth.ts               # detect CLI on PATH, probe auth, sign-in flow
│   ├── resolvedCli.ts        # process-wide cache for the absolute CLI path
│   │
│   └── test/
│       ├── unit/             # pure-module tests run under tsx (no VS Code host)
│       ├── integration/      # spawn-driven tests against fixtures/mock-claude.js
│       └── fixtures/
│           └── mock-claude.js  # scriptable stand-in for the `claude` CLI
│
├── scripts/
│   └── test.mjs              # cross-platform .test.ts runner (Node --test + tsx)
│
├── dist/                     # esbuild output (extension.js + .map). Shipped in VSIX.
├── esbuild.js                # bundles src/extension.ts → dist/extension.js
├── tsconfig.json             # strict TS, ES2022, Node16 modules; emits to `out/` (typecheck only)
├── package.json              # extension manifest: contributes settings/commands/keybindings
├── .vscodeignore             # excludes src/, scripts/, .github/, etc. from the VSIX
├── .vscode/                  # launch.json + tasks.json for F5 dev-host
├── .github/workflows/ci.yml  # matrix CI (linux/mac/win), packages + publishes on tag
└── icon.png                  # extension icon
```

---

## 3. Source files, in dependency order

The code reads bottom-up. Start with the pure modules, then the I/O wrappers, then the VS Code glue.

### 3.1 Pure modules (no VS Code, no I/O)

These are unit-tested under `src/test/unit/`.

#### `src/streamParser.ts`
NDJSON parser for the CLI's `--output-format stream-json` output. Buffers partial trailing lines across `feed()` calls. Classifies each line into one of:
`init` · `text` · `stop` · `result` · `error` · `unknown`.

Important quirk: the CLI emits both per-token `content_block_delta` events *and* a final top-level `assistant` envelope containing the full message. We always pass `--include-partial-messages`, so the deltas already cover the full text — the `assistant` envelope is intentionally classified as `unknown` to avoid double-counting. (See the comment at the bottom of `classify()`.)

#### `src/promptBuilder.ts`
Builds the FIM-style prompt sent to the model.

- `buildPrompt(input)` → `{ systemPrompt, userPrompt, mode, suggestedMaxOutputTokens }`. The user prompt is literally `File: …\nLanguage: …\n\n<prefix><FILL_HERE><suffix>`.
- `computeWindows(text, offset, maxPrefix, maxSuffix)` slices the document around the cursor. It first slices `2× max` then trims to a line boundary, so we never allocate the whole document in giant files.
- `detectMode(prefix, suffix)` decides `single-line` vs `multi-line` from cursor context. Empty current line, structural opener (`{`, `(`, `[`, `,`, `:`, `=>`) at the cursor → multi-line. Mid-statement → single-line. The mode controls both the system prompt (different rules) and the suggested output-token cap (48 vs 256).
- `trimToLineBoundary(s, maxChars, side)` is the snap-to-line helper.

System prompts live as string constants at the top — `BASE_RULES + SINGLE_LINE_RULES` or `BASE_RULES + MULTI_LINE_RULES`. Tweak there to shape model behaviour.

#### `src/completionCleaner.ts`
Post-processes raw model output before showing it.

- `cleanCompletion({ raw, followingText })` — strips backtick fences (full block, leading-only, trailing-only, or single-backtick wraps), drops a leading narration line if present, drops a parroted `<FILL_HERE>`, trims trailing whitespace, then `stripSuffixOverlap` against the document text following the cursor (so we don't re-insert what's already there).
- `looksLikeNarration(head)` — pattern-matches "Here is", "Let me", markdown headings, etc. Used both inside `cleanCompletion` and as a streaming early-exit signal in `inlineProvider`.
- `looksLikeCompleteUnit(accumulated)` — heuristic that says "the model has produced a complete-enough output, kill the subprocess". Triggers on triple newline, balanced braces ending in `}`, or a statement terminator followed by non-indented code. Used during streaming to cut off late tokens.

#### `src/cache.ts`
LRU map keyed by a SHA-1 of `(filename, languageId, prefix, suffix, model, mode, shape)`.

- `get`/`set` are standard LRU (Map insertion order = recency).
- `setWithShifts(key, value, opts)` is the **prefix-shift** trick — when we get back a completion `value`, we also write derived entries for cursor positions `+1`, `+2`, … `+maxShift` characters into the suggestion, with the corresponding tail as the cached value. So as the user types into the suggestion exactly as the model proposed it, every keystroke produces a sub-5ms cache hit. Derived entries get a much shorter TTL (10s vs 60s base).

Misuse note: `setWithShifts` only helps if the user types *exactly* the suggested text. Any deviation falls through to a fresh CLI call (correct, just no longer cached).

#### `src/skipHeuristics.ts`
Cheap predicates that decide whether to bail before spawning. Called only after a cache miss, so cache hits always win. Reasons returned:
- `disabled-language`
- `has-selection`
- `last-edit-deletion` (only on `Automatic` triggers — manual triggers always go through)
- `cursor-in-middle-of-identifier` (don't split a name like `foo|Bar`)

Also exports `adjustForBatterySaver(debounceMs, batterySaver)` which floors the debounce to 1200ms when battery saver is on.

### 3.2 I/O wrappers (use Node, not VS Code APIs)

#### `src/cliClient.ts`
**The latency-control surface.** Wraps a `child_process.spawn` of the Claude CLI.

Key responsibilities:
- Build the slim spawn env via `buildSpawnEnv()` — explicit allowlist of relevant vars (PATH, HOME, proxy, SSL, XDG, Windows essentials, `CLAUDE_*`/`ANTHROPIC_*` passthrough). Avoids serializing Electron's full env on every spawn.
- Layer `FAST_MODE_ENV` defaults (the `CLAUDE_CODE_DISABLE_*` vars) — skips auto-memory, claude.md auto-discovery, background tasks, internal "thinking" tokens, prompt history, etc. **Roughly halves per-request CLI startup cost without breaking OAuth.** User-set values from the parent env take precedence.
- Pick CLI args optimised for one-shot completion: `-p <userPrompt>`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--system-prompt <…>`, `--model <…>`, `--strict-mcp-config`, `--setting-sources ''`, `--disable-slash-commands`, `--tools ''`, `--no-session-persistence`, `--permission-mode bypassPermissions`. Comments call out why `--bare` is *not* used (forces API-key auth and breaks OAuth).
- Stream stdout through `StreamParser`, accumulate text deltas, fire the caller-supplied `onText(text, accumulated)` per delta. **If `onText` returns `true`, we kill the child** — that's the streaming early-exit hook.
- Cancellation: external `AbortSignal` and a `.cancel()` method on the run. SIGTERM, then SIGKILL after 200ms if the child doesn't exit.
- Read the resolved absolute path from `getResolvedCliPath()` so we skip PATH lookup on every spawn.
- Emit `cli.run` metric on close: `ms_total`, `ms_first_token`, `chars`, `exit`, `early_exit`, etc.

#### `src/auth.ts`
- `detectCli(cliPath)` — resolve the binary (via `which`/`where` if a bare name) then run `--version` as a presence check. Returns `{ found, resolvedPath, version }`.
- `probeAuth(cliPath, model, timeoutMs)` — spawn a tiny `-p "ok"` request. If we see a `system/init` event before timeout, the user is authed. Stderr is matched for `not logged in`/`unauthor`/`oauth` patterns and surfaced as the failure reason. Does not use `--bare` (would force API-key auth).
- `signInFlow(cliPath)` — opens a transient integrated terminal and runs `cliPath login || cliPath`, then prompts the user to reload the window. **Path is POSIX-single-quoted** (`shellQuote`) before sending to the terminal to prevent shell injection.
- `notifyMissingCli(cliPath)` — error toast with "Install" and "Open Settings" actions.

#### `src/resolvedCli.ts`
Tiny module: a `Map<configuredPath, absolutePath>` cache. `setResolvedCliPath` is called once at startup from `extension.ts`; `getResolvedCliPath` is called on every CLI spawn. Skipping PATH lookup on the hot path is worth a few stat() calls per request.

### 3.3 VS Code glue

#### `src/extension.ts`
The activation entry point. `package.json` declares `onStartupFinished`, so this runs after VS Code finishes startup.

`activate(context)`:
1. Read config, create `StatusBar`, create `InlineProvider` and `IntellisenseProvider`.
2. Register the providers conditionally (only the languages in `cfg.languages`, only the surfaces enabled by `cfg.enableInline` / `cfg.enableIntellisense`).
3. Register all commands (delegated to `commands.ts`).
4. Subscribe to `onConfigChange`: re-register providers if language list / enable flags / enabled changed; clear the resolved-CLI cache and re-probe if `cliPath` changed.
5. **Defer** `runStartupChecks()` (CLI presence + auth probe) so activation stays snappy. If the CLI is missing, toast + status-bar error. If unauthed, toast + offer Sign In.

`deactivate()` disposes the dynamically-registered provider handles (the rest are in `context.subscriptions`).

#### `src/config.ts`
Strongly-typed view over `claude.completions.*` settings. Two non-trivial bits:
- `getTrustedCliPath` — **only honors `cliPath` from User (global) settings**. A workspace `.vscode/settings.json` can't redirect the binary; if it tries, we log a `console.warn` and fall back to the User value (or the default `"claude"`).
- `onConfigChange(handler)` filters `onDidChangeConfiguration` to our section.

#### `src/commands.ts`
Registers the five commands declared in `package.json`:
- `claude.completions.toggle` — flip the `enabled` setting.
- `claude.completions.triggerNow` — `editor.action.inlineSuggest.trigger`.
- `claude.completions.clearCache` — clears `InlineProvider`'s LRU.
- `claude.completions.openLogs` — `logger.show()`.
- `claude.completions.signIn` — calls `auth.signInFlow`.

#### `src/statusBar.ts`
Right-aligned status-bar item with five visual states: `ready` (sparkle), `thinking` (sync~spin), `error` (error icon, errorBackground), `disabled` (circle-slash), `unauth` (key, warningBackground). Click target is `claude.completions.openLogs` by default; flips to `claude.completions.signIn` while in the `unauth` state. `setThinking` and `setError` auto-fall-back to `setReady` after 30s and 8s respectively (defensive — keeps the bar honest if a callsite forgets to clear).

#### `src/logger.ts`
Thin wrapper over `vscode.window.createOutputChannel('Claude Inline Completions')`. Falls back to a console-backed channel if `require('vscode')` fails — that branch lets unit tests import any module that touches `logger` without booting an extension host. Methods: `info`/`warn`/`error`/`debug`/`metric`. `metric` is just a structured info-level line; everything is logged with an ISO timestamp.

#### `src/completionProvider.ts`
The optional IntelliSense list provider. Kept simple intentionally — every call spawns a CLI subprocess (no caching, no prefetch, no early-exit). Wired up only when `claude.completions.enableIntellisense` is true. Inserts a single `CompletionItem` with `sortText: ' claude'` so it floats to the top.

#### `src/inlineProvider.ts`
The inline-ghost-text provider. **The most complex file in the repo.** Worth a careful read on its own; see §4 for the request flow.

Three concurrent state surfaces:
- `inFlight: ClaudeRun | null` — the on-demand request triggered by VS Code's `provideInlineCompletionItems` call.
- `prefetch: PendingPrefetch | null` — the speculative request fired in response to a trigger character.
- `pendingDebounce: NodeJS.Timeout | null` — the debounce timer for the on-demand path.

Each is independently cancellable. The provider keeps a `WeakMap<TextDocument, DocumentEditState>` so `shouldSkip` can see "ms since last edit" and "was the last edit a deletion".

Per-URI rel-path cache (`RELPATH_CACHE`) avoids re-resolving workspace folders on every keystroke; capped at 256 entries with a hard reset.

---

## 4. Request flow (one keystroke → ghost text)

Step-by-step, with the file/function for each step:

1. **Keystroke fires** → VS Code emits `onDidChangeTextDocument`.
2. `inlineProvider.ts` listens → records `lastEditAt` + `lastEditWasDeletion` → calls `maybeSchedulePrefetch`.
3. **Prefetch path** (`inlineProvider.ts:maybeSchedulePrefetch` → `firePrefetch`): if the just-typed character matches `PREFETCH_TRIGGER_RE` (newline, space, or structural punctuation) we wait `PREFETCH_DEBOUNCE_MS` (80ms) and then spawn a CLI run **before VS Code asks for a suggestion**. Coalescing: if we already have a prefetch in flight whose prefix is a strict prefix of the new context (≤8 chars typed since), we let it finish instead of restarting.
4. **VS Code's debounce fires** → it calls `provideInlineCompletionItems(document, position, context, token)`.
5. **Language gate.** If `document.languageId` isn't in `cfg.languages`, return null immediately.
6. **Compute prefix/suffix windows** (`promptBuilder.ts:computeWindows`).
7. **Detect mode** (`promptBuilder.ts:detectMode`) — single-line vs multi-line.
8. **Cache lookup** (`cache.ts:get`). Hits return immediately and never spawn.
9. **Skip heuristics** (`skipHeuristics.ts:shouldSkip`). Selection? Mid-identifier? Bail.
10. **Adopt prefetch?** If a prefetch is in-flight for the exact same key, await it instead of spawning a duplicate.
11. **Debounce + spawn** (`runWithDebounce` → `spawnRun` → `cliClient.ts:ClaudeCli.run`):
    - `buildPrompt` assembles system + user prompt.
    - Token cap = `min(cfg.maxOutputTokens, suggestedMaxOutputTokens)`.
    - `onText` callback enforces three streaming guards: (a) narration sniffer for short outputs, (b) hard newline cutoff in single-line mode, (c) `looksLikeCompleteUnit` for long outputs. Returning `true` from `onText` kills the subprocess.
12. **Stream parsing** — `streamParser.ts:StreamParser` consumes NDJSON, accumulating only `text_delta` events.
13. **Result handling** (`awaitRun`):
    - Honour cancellation/kill.
    - Surface mid-session auth loss (`Not logged in`, `oauth`, `unauthor`) to the status bar via `setUnauth()`.
    - Hard-trim past first newline in single-line mode (the early-exit kills the child but a `\n` may already be in the buffer).
    - `cleanCompletion` normalises the output.
14. **Cache write** (`cache.ts:setWithShifts`) — base entry plus up to 15 prefix-shift derived entries (10s TTL).
15. **Return** an `InlineCompletionList` with one item at the cursor position. VS Code shows it as ghost text.

Cancellation path: if the user types again before the request lands, VS Code fires the cancellation token; `inlineProvider` calls `run.cancel()`; `cliClient` SIGTERMs the child (SIGKILL after 200ms).

Retrigger trick: when a prefetch lands and the cursor hasn't moved (`maybeRetrigger`), we run `editor.action.inlineSuggest.trigger`. VS Code calls `provideInlineCompletionItems` again, hits the now-warm cache, and renders in <5ms. That's the "Cursor magic" — the user sees a suggestion appear without having paused for the model.

---

## 5. Configuration surface (where settings live)

`package.json` declares all settings under `claude.completions.*`. `src/config.ts` parses them into `CompletionsConfig`.

| Key | Where read | What it gates |
|---|---|---|
| `enabled` | `extension.ts`, `inlineProvider.ts`, `completionProvider.ts` | master switch |
| `cliPath` | `auth.ts`, `cliClient.ts` (via `resolvedCli.ts`) | which binary to spawn |
| `model` | `cliClient.ts` (`--model` arg), `auth.ts` | model the CLI invokes |
| `debounceMs` | `inlineProvider.ts` (in `runWithDebounce`) | wait after keystroke |
| `maxPrefixChars` / `maxSuffixChars` | `promptBuilder.ts:computeWindows` | context size |
| `maxOutputTokens` | `inlineProvider.ts:spawnRun`, `completionProvider.ts` | output cap |
| `languages` | `extension.ts:registerProviders`, `inlineProvider.ts`, `completionProvider.ts` | active language IDs |
| `enableInline` / `enableIntellisense` | `extension.ts:registerProviders` | which surfaces are registered |
| `batterySaver` | `inlineProvider.ts` (via `skipHeuristics.adjustForBatterySaver`), `completionProvider.ts` | floor debounce, gate IntelliSense |

---

## 6. Building, running, debugging

### Local development

```bash
npm install
npm run watch          # esbuild watch mode → dist/extension.js
# Then in VS Code, press F5 → "Run Extension" launches an Extension Development Host
```

The `.vscode/launch.json` `Run Extension` config sets `--extensionDevelopmentPath` and runs the default build task (`npm: watch`) first. Open any supported file inside the dev host and start typing — completions should appear after ~250ms (or use `Ctrl+Alt+\`).

### Building

```bash
npm run compile        # one-shot dev build (sourcemaps, no minify)
npm run package        # production bundle (minified, no sourcemap)
npm run typecheck      # tsc --noEmit
npm run lint
```

`esbuild.js` bundles `src/extension.ts` to `dist/extension.js` as a CJS Node 18 target, externalizing `vscode`. The TypeScript compiler is **not** used to emit JS — only for type-checking. `tsconfig.json`'s `outDir: "out"` is a remnant of `vscode-test` patterns; nothing reads that directory at runtime.

### Packaging the VSIX

```bash
npx vsce package --no-dependencies --out claude-inline-completions.vsix
```

`.vscodeignore` excludes `src/`, `scripts/`, `.github/`, the sourcemap, and TypeScript files from the VSIX. Only `dist/extension.js`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `icon.png` ship.

---

## 7. Testing

Two suites, both run under Node's built-in test runner via `tsx`:

```bash
npm test               # unit + integration
npm run test:unit      # pure modules — cache, completionCleaner, promptBuilder, streamParser
npm run test:integration  # cliClient against fixtures/mock-claude.js
```

`scripts/test.mjs` walks the target directory for `.test.ts` files and invokes `node --import tsx --test <files>`. It exists because PowerShell does not glob-expand `*.test.ts` like POSIX shells, so we needed an explicit walker for cross-OS CI.

### `src/test/fixtures/mock-claude.js`
Drop-in replacement for the `claude` binary. Reads a `MOCK_CLAUDE_SCRIPT` env var (JSON document with an `events: [{ delay, type, text }]` array) and emits the same NDJSON shape the real CLI does. Supports `init`, `text`, `stop`, `result`, and `raw` events; honours SIGTERM/SIGINT for cancellation tests. `--version` returns a stub. Integration tests `chmod +x` it before use.

### Unit tests
- `cache.test.ts` — get/set, TTL expiry, LRU eviction, mode separation, `setWithShifts` correctness, derived-entry TTL.
- `completionCleaner.test.ts` — narration detection, fence stripping, suffix-overlap dedup, `looksLikeCompleteUnit` heuristics.
- `promptBuilder.test.ts` — FILL_HERE placement, mode detection across cursor contexts, line-boundary trimming, large-document window-only allocation.
- `streamParser.test.ts` — text/init/error classification, split-line buffering, malformed lines as `unknown`, `assistant` envelope ignored.

### Integration tests
- `cliClient.test.ts` — happy path, manual cancel kills child, `onText` early-exit, `AbortSignal` cancellation. Each test sets `cliPath` to the absolute mock path and passes a `MOCK_CLAUDE_SCRIPT` via env.

### CI

`.github/workflows/ci.yml`:
- **test** job — matrix `{ ubuntu, macos, windows }` × Node 20: `npm ci`, `typecheck`, `lint` (continue-on-error), `npm test`, `npm run package`.
- **package** job — on push to `main` or any tag: builds and uploads the VSIX as a workflow artifact.
- **publish** job — only on `v*` tags, in the `marketplace` environment: `vsce publish` with `VSCE_PAT` from secrets.

---

## 8. Latency & performance — what to know before changing anything hot

The performance story is in `cliClient.ts`, `inlineProvider.ts`, `cache.ts`, and the `FAST_MODE_ENV` block. Before touching any of them, understand what's already happening:

1. **Pre-resolved CLI path** (`resolvedCli.ts`) — saves PATH lookup on every spawn.
2. **Slim spawn env** (`buildSpawnEnv`) — passes ~25 vars instead of all of `process.env`.
3. **Fast-mode env vars** (`FAST_MODE_ENV` in `cliClient.ts`) — empirically halves per-request CLI startup. **Read the comment block before adding/removing entries.** `CLAUDE_CODE_SIMPLE=1` specifically breaks keychain reads → don't add it.
4. **Speculative prefetch on trigger chars** — fires CLI during the user's pause; lands cached.
5. **Prefix-shift cache** (`cache.setWithShifts`) — typing-into-suggestion gets sub-5ms cache hits.
6. **Streaming early-exit** (`onText` returns `true`) — three triggers: narration, single-line newline, complete-unit detection.
7. **Prefetch coalescing** — ≤8-char prefix extension reuses the in-flight request rather than killing/respawning.
8. **Per-URI rel-path cache** (`RELPATH_CACHE` in `inlineProvider.ts`) — avoids `getWorkspaceFolder` allocation on every keystroke.

Latency targets (warm steady-state on a Pro/Max account):
- Cache hit: <5ms
- Prefix-shift hit: <5ms per keystroke
- Prefetch landed during pause: 0ms perceived
- Warm CLI request: ~1.3–2.5s
- Cold first request after long idle: ~4–5s

Latency telemetry is logged via `logger.metric('cli.run', { ms_total, ms_first_token, … })` and `inline.complete` / `prefetch.complete`. View with **Claude: Open Logs**.

---

## 9. Security model

Three things to keep in mind:

1. **`cliPath` is User-scope only** (`config.ts:getTrustedCliPath`). A malicious workspace can't redirect the binary via `.vscode/settings.json`. If you change anything in this codepath, preserve that restriction.
2. **Sign-in flow POSIX-quotes the path** (`auth.ts:shellQuote`). Don't replace it with naive interpolation.
3. **Permissions.** The CLI runs with `--permission-mode bypassPermissions` *inside the spawned subprocess*, but with `--tools ''` so no tools are available — the CLI is operating purely as an LLM endpoint. `--strict-mcp-config`, `--setting-sources ''`, `--disable-slash-commands`, and `--no-session-persistence` further constrain it.

---

## 10. How to add a feature — common recipes

### Add a new setting
1. Declare it in `package.json` under `contributes.configuration.properties`.
2. Add the field + read it in `src/config.ts:CompletionsConfig` / `getConfig`.
3. Read `cfg.<yourField>` wherever you need it.
4. If toggling it should re-register providers, add it to the `onConfigChange` comparison in `extension.ts`.

### Add a new command
1. Declare it in `package.json` under `contributes.commands` (and `contributes.keybindings` if applicable).
2. Register a handler in `src/commands.ts`.
3. Use `vscode.commands.executeCommand('claude.completions.<name>')` if you need to fire it programmatically.

### Tweak prompt behaviour
- Change the `BASE_RULES` / `SINGLE_LINE_RULES` / `MULTI_LINE_RULES` strings in `promptBuilder.ts`.
- Add tests in `src/test/unit/promptBuilder.test.ts`.

### Add a streaming early-exit signal
- Add a heuristic to `completionCleaner.ts` (`looksLikeCompleteUnit` or a new function).
- Wire it into the `onText` callback in `inlineProvider.ts:spawnRun`.
- Test it in `src/test/integration/cliClient.test.ts` using a scripted mock.

### Support a new CLI auth state
- Add a state to `StatusBar` in `src/statusBar.ts`.
- Detect it in `auth.ts:probeAuth` (boot-time) or `cliClient.ts` result handling (mid-session).
- Surface from `inlineProvider.ts:awaitRun`'s `errorMessage` branch.

---

## 11. Things to know that aren't obvious from the code

- **`activate()` is non-blocking after the synchronous setup.** `runStartupChecks()` is fire-and-forget so a missing/unauthed CLI doesn't delay activation.
- **`tsconfig.json` emits to `out/` but nothing runs from there.** That directory only matters for `tsc --noEmit` type-checking. The actual ship artifact comes from esbuild → `dist/extension.js`. The `Extension Tests` launch config in `.vscode/launch.json` references `out/test/runTest`, which doesn't exist — that config is currently unused; F5 → "Run Extension" is the working dev loop.
- **`logger.ts` lazy-resolves `vscode`.** That lets pure-module unit tests import any file without requiring an extension host.
- **The IntelliSense path is intentionally less optimised** than inline. It has no caching, no prefetch, and no early-exit. Users opt into it knowing each call spawns a subprocess.
- **`onText` early-exit kills the child but text already in the stdout buffer is still in `accumulated`.** That's why single-line mode also hard-trims past the first newline in `awaitRun`.
- **`completionProvider.ts:isOnBattery` always returns false.** VS Code doesn't expose battery state to extensions; we instead respect the user's `batterySaver` flag verbatim.
- **The mock CLI's `--version` flag is hard-coded** in `mock-claude.js` so `auth.detectCli` works in integration tests if someone ever points it there directly.

---

## 12. Where to start if you're new

1. Read `src/streamParser.ts` and its tests — smallest pure module.
2. Read `src/cache.ts` and its tests — understand `setWithShifts`.
3. Read `src/promptBuilder.ts` and its tests — see how cursor context shapes the prompt.
4. Read `src/cliClient.ts` end-to-end — note the env shaping, fast-mode flags, and cancellation.
5. Read `src/inlineProvider.ts` end-to-end — follow `provideInlineCompletionItems` and `firePrefetch` separately, then see how they intersect via `prefetch` adoption.
6. Run `npm test` — make sure your environment is healthy.
7. F5 in VS Code — try a real completion in the dev host. Open **Claude: Open Logs** to watch the metric stream.

After that, you'll have the whole picture.
