import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeCli, ClaudeRun } from './cliClient';
import { buildPrompt, computeWindows, detectMode, CompletionMode } from './promptBuilder';
import { cleanCompletion, looksLikeNarration, looksLikeCompleteUnit } from './completionCleaner';
import { CompletionCache, CompletionCacheKey } from './cache';
import { shouldSkip, adjustForBatterySaver } from './skipHeuristics';
import { CompletionsConfig } from './config';
import { logger } from './logger';
import { StatusBar } from './statusBar';

interface DocumentEditState {
  lastEditAt: number;
  lastEditWasDeletion: boolean;
}

const NARRATION_GUARD_CHARS = 120;
const PREFETCH_DEBOUNCE_MS = 80;
// Trigger characters that suggest the user is at a natural completion boundary.
// Newline, space, and structural punctuation are good candidates; identifier
// characters are not (we'd fire mid-word constantly).
const PREFETCH_TRIGGER_RE = /[\n\s\(\[\{,;:=>.\|&]$/;

interface PendingPrefetch {
  run: ClaudeRun;
  cacheKey: CompletionCacheKey;
  documentVersion: number;
  uri: string;
  offset: number;
}

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private cache = new CompletionCache(100, 60_000);
  private docState = new WeakMap<vscode.TextDocument, DocumentEditState>();
  private inFlight: ClaudeRun | null = null;
  private pendingDebounce: NodeJS.Timeout | null = null;
  private prefetchTimer: NodeJS.Timeout | null = null;
  private prefetch: PendingPrefetch | null = null;
  private docListener: vscode.Disposable;

  constructor(private getCfg: () => CompletionsConfig, private statusBar: StatusBar) {
    this.docListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return; // selection-only event
      // Treat as a deletion only when ALL changes are pure deletions. A
      // search-replace or composite edit that inserts text should NOT
      // suppress completion just because a cleanup of dead code happened.
      const wasDeletion = e.contentChanges.every(
        (c) => c.text === '' && c.rangeLength > 0
      );
      this.docState.set(e.document, {
        lastEditAt: Date.now(),
        lastEditWasDeletion: wasDeletion
      });
      this.maybeSchedulePrefetch(e.document);
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  cancelInFlight(): void {
    if (this.inFlight) {
      this.inFlight.cancel();
      this.inFlight = null;
    }
    if (this.pendingDebounce) {
      clearTimeout(this.pendingDebounce);
      this.pendingDebounce = null;
    }
  }

  private cancelPrefetch(): void {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    if (this.prefetch) {
      this.prefetch.run.cancel();
      this.prefetch = null;
    }
  }

  dispose(): void {
    this.cancelInFlight();
    this.cancelPrefetch();
    this.docListener.dispose();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null | undefined> {
    const cfg = this.getCfg();
    if (!cfg.enabled || !cfg.enableInline) return null;

    // Language gate: cheap and first.
    if (!cfg.languages.includes(document.languageId)) return null;

    const text = document.getText();
    const offset = document.offsetAt(position);
    const filename = relPath(document);

    const { prefix, suffix } = computeWindows(text, offset, cfg.maxPrefixChars, cfg.maxSuffixChars);
    const shape = detectMode(prefix, suffix);

    const cacheKey: CompletionCacheKey = {
      filename,
      languageId: document.languageId,
      prefix,
      suffix,
      model: cfg.model,
      mode: 'inline' as const,
      shape
    };

    // Cache lookup BEFORE skip heuristics. A cache hit is ~5us and always
    // safe — if we have a known-good completion for this exact context,
    // serve it. Skip heuristics only matter when we'd otherwise spawn.
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.metric('inline.cacheHit', { chars: cached.length });
      return makeList(cached, position);
    }

    // Now apply skip heuristics — they only gate spawning, not serving.
    const editor = vscode.window.activeTextEditor;
    const selectionLength =
      editor && editor.document === document
        ? Math.abs(
            document.offsetAt(editor.selection.end) -
            document.offsetAt(editor.selection.start)
          )
        : 0;
    const state = this.docState.get(document) ?? { lastEditAt: 0, lastEditWasDeletion: false };
    const skip = shouldSkip({
      document,
      position,
      enabledLanguages: cfg.languages,
      triggerKind: context.triggerKind,
      msSinceLastEdit: Date.now() - state.lastEditAt,
      lastEditWasDeletion: state.lastEditWasDeletion,
      batterySaver: cfg.batterySaver,
      selectionLength
    });
    if (skip) {
      logger.debug('inline.skip', { reason: skip });
      return null;
    }

    // If a prefetch is in-flight for this exact (prefix, suffix), await it
    // instead of firing a duplicate request.
    if (this.prefetch && cacheKeysEqual(this.prefetch.cacheKey, cacheKey)) {
      const adopted = this.prefetch;
      logger.debug('inline.adoptPrefetch');
      try {
        const result = await this.awaitRun(adopted.run, suffix, token, shape);
        if (this.prefetch === adopted) this.prefetch = null;
        if (!result) return null;
        this.cache.setWithShifts(cacheKey, result);
        return makeList(result, position);
      } catch {
        if (this.prefetch === adopted) this.prefetch = null;
      }
    }

    if (token.isCancellationRequested) return null;

    const completion = await this.runWithDebounce({
      document,
      cfg,
      filename,
      prefix,
      suffix,
      cacheKey,
      shape,
      token,
      isManual: context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
    });

    if (!completion) return null;
    this.cache.setWithShifts(cacheKey, completion);
    return makeList(completion, position);
  }

  /**
   * Called from onDidChangeTextDocument. If the just-typed character is a
   * good completion boundary, schedule a background CLI run after a short
   * delay. By the time the editor's debounce fires, the request is already
   * in flight (or finished and in the cache).
   */
  private maybeSchedulePrefetch(document: vscode.TextDocument): void {
    const cfg = this.getCfg();
    if (!cfg.enabled || !cfg.enableInline) return;
    if (!cfg.languages.includes(document.languageId)) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) return;
    if (!editor.selection.isEmpty) return;

    const position = editor.selection.active;
    // Avoid document.getText() for the trigger-char check — large files would
    // pay the full text-allocation cost on every keystroke. lineAt() returns
    // the current line cheaply.
    const line = document.lineAt(position.line).text;
    const charIdx = position.character;
    const before = charIdx > 0 ? line[charIdx - 1] : (position.line > 0 ? '\n' : '');
    if (!before || !PREFETCH_TRIGGER_RE.test(before)) return;

    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }

    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.firePrefetch(document, position);
    }, PREFETCH_DEBOUNCE_MS);
  }

  private firePrefetch(document: vscode.TextDocument, position: vscode.Position): void {
    const cfg = this.getCfg();
    if (!cfg.enabled || !cfg.enableInline) return;

    const text = document.getText();
    const offset = document.offsetAt(position);
    if (offset !== document.offsetAt(document.validatePosition(position))) return;

    // Cursor must still be where we scheduled — if the user kept typing or
    // moved, abort. The next change-event will reschedule.
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) return;
    if (!editor.selection.active.isEqual(position)) return;

    const filename = relPath(document);
    const { prefix, suffix } = computeWindows(text, offset, cfg.maxPrefixChars, cfg.maxSuffixChars);
    const shape = detectMode(prefix, suffix);
    const cacheKey: CompletionCacheKey = {
      filename,
      languageId: document.languageId,
      prefix,
      suffix,
      model: cfg.model,
      mode: 'inline',
      shape
    };

    // Already cached or already prefetching this exact context — no-op.
    if (this.cache.get(cacheKey)) return;
    if (this.prefetch && cacheKeysEqual(this.prefetch.cacheKey, cacheKey)) return;

    // Coalescing: if a prefetch is in flight for an earlier-but-related
    // context (same file/language, prefix is a strict prefix of the new
    // prefix, suffix matches, ≤8 chars typed since), let it finish. Its
    // result will be useful via the prefix-shift cache; killing and
    // restarting just burns ~1.2s of work.
    if (this.prefetch) {
      const p = this.prefetch.cacheKey;
      const sameContext =
        p.filename === cacheKey.filename &&
        p.languageId === cacheKey.languageId &&
        p.model === cacheKey.model &&
        p.suffix === cacheKey.suffix &&
        p.shape === cacheKey.shape &&
        cacheKey.prefix.startsWith(p.prefix) &&
        cacheKey.prefix.length - p.prefix.length <= 8;
      if (sameContext) {
        logger.debug('prefetch.coalesce', {
          deltaChars: cacheKey.prefix.length - p.prefix.length
        });
        return;
      }
      // Different enough — cancel and restart.
      this.prefetch.run.cancel();
      this.prefetch = null;
    }

    const run = this.spawnRun({ cfg, document, filename, prefix, suffix, shape });
    if (!run) return;

    const pending: PendingPrefetch = {
      run,
      cacheKey,
      documentVersion: document.version,
      uri: document.uri.toString(),
      offset
    };
    this.prefetch = pending;
    logger.metric('prefetch.start', { offset });

    void run.promise.then((result) => {
      if (this.prefetch !== pending) return;
      this.prefetch = null;
      if (result.killed && !result.earlyExit) {
        logger.debug('prefetch.cancelled');
        return;
      }
      if (result.exitCode !== null && result.exitCode !== 0 && !result.earlyExit) {
        logger.warn('prefetch.exitNonZero', { exit: result.exitCode });
        return;
      }
      let raw = result.text;
      if (shape === 'single-line') {
        const nl = raw.indexOf('\n');
        if (nl !== -1) raw = raw.slice(0, nl);
      }
      const cleaned = cleanCompletion({ raw, followingText: suffix.slice(0, 200) });
      if (!cleaned) {
        logger.debug('prefetch.emptyAfterClean');
        return;
      }
      this.cache.setWithShifts(cacheKey, cleaned);
      logger.metric('prefetch.complete', {
        ms_first_token: result.msFirstToken,
        ms_total: result.msTotal,
        chars: cleaned.length,
        shape
      });

      // Cursor-still-here check + retrigger.
      // If the user hasn't moved/typed since the prefetch fired, ask VS Code
      // to re-show inline suggestions. Cache is already warm so the next
      // provideInlineCompletionItems call resolves in <5ms.
      this.maybeRetrigger(pending);
    }).catch((err) => {
      if (this.prefetch === pending) this.prefetch = null;
      logger.warn('prefetch.error', { err: String(err) });
    });
  }

  private maybeRetrigger(pending: PendingPrefetch): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document.uri.toString() !== pending.uri) return;
    if (editor.document.version !== pending.documentVersion) return;
    if (editor.document.offsetAt(editor.selection.active) !== pending.offset) return;
    if (!editor.selection.isEmpty) return;
    // Fire and forget — VS Code will call provideInlineCompletionItems again,
    // which will hit the now-warm cache and return immediately.
    void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    logger.debug('prefetch.retrigger');
  }

  private async runWithDebounce(opts: {
    document: vscode.TextDocument;
    cfg: CompletionsConfig;
    filename: string;
    prefix: string;
    suffix: string;
    cacheKey: CompletionCacheKey;
    shape: CompletionMode;
    token: vscode.CancellationToken;
    isManual: boolean;
  }): Promise<string | null> {
    const { document, cfg, filename, prefix, suffix, cacheKey, shape, token, isManual } = opts;

    const debounceMs = isManual ? 0 : adjustForBatterySaver(cfg.debounceMs, cfg.batterySaver);

    this.cancelInFlight();

    if (debounceMs > 0) {
      const ok = await this.delay(debounceMs, token);
      if (!ok) return null;
    }

    if (token.isCancellationRequested) return null;

    // Re-check cache after debounce — a prefetch may have completed.
    const lateHit = this.cache.get(cacheKey);
    if (lateHit) {
      logger.metric('inline.cacheHitAfterDebounce', { chars: lateHit.length });
      return lateHit;
    }

    // If a prefetch is in flight for the same key, adopt it.
    if (this.prefetch && cacheKeysEqual(this.prefetch.cacheKey, cacheKey)) {
      const adopted = this.prefetch;
      logger.debug('inline.adoptPrefetchAfterDebounce');
      const result = await this.awaitRun(adopted.run, suffix, token, shape);
      if (this.prefetch === adopted) this.prefetch = null;
      return result;
    }

    this.statusBar.setThinking();

    const run = this.spawnRun({ cfg, document, filename, prefix, suffix, shape });
    if (!run) return null;
    this.inFlight = run;

    const tokenSub = token.onCancellationRequested(() => run.cancel());
    try {
      const result = await this.awaitRun(run, suffix, token, shape);
      if (this.inFlight === run) this.inFlight = null;
      this.statusBar.setReady();
      return result;
    } finally {
      tokenSub.dispose();
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  /**
   * Spawn a CLI run with the standard prompt assembly + early-exit guards.
   * Used by both prefetch and the on-demand path. Caller passes pre-computed
   * prefix/suffix windows to avoid re-allocating the full document text.
   */
  private spawnRun(opts: {
    cfg: CompletionsConfig;
    document: vscode.TextDocument;
    filename: string;
    prefix: string;
    suffix: string;
    shape: CompletionMode;
  }): ClaudeRun | null {
    const { cfg, document, filename, prefix, suffix, shape } = opts;
    const built = buildPrompt({
      prefix,
      suffix,
      languageId: document.languageId,
      filename,
      mode: shape
    });

    // Honor the user's explicit cap if it's tighter; otherwise use the
    // shape-aware suggestion.
    const tokenCap = Math.min(cfg.maxOutputTokens, built.suggestedMaxOutputTokens);

    return ClaudeCli.run({
      cliPath: cfg.cliPath,
      model: cfg.model,
      systemPrompt: built.systemPrompt,
      userPrompt: built.userPrompt,
      maxOutputTokens: tokenCap,
      cwd: workspaceCwd(document),
      onText: (_text, accumulated) => {
        if (accumulated.length <= NARRATION_GUARD_CHARS && looksLikeNarration(accumulated)) {
          return true;
        }
        // Single-line mode: bail at the very first newline. The model has
        // delivered a full single-line completion; anything past \n is bonus
        // we don't want.
        if (shape === 'single-line' && accumulated.includes('\n')) {
          return true;
        }
        if (accumulated.length > NARRATION_GUARD_CHARS && looksLikeCompleteUnit(accumulated)) {
          return true;
        }
        return false;
      }
    });
  }

  /** Awaits a run, cleans output, returns the final text or null. */
  private async awaitRun(
    run: ClaudeRun,
    suffix: string,
    token: vscode.CancellationToken,
    shape?: CompletionMode
  ): Promise<string | null> {
    try {
      const result = await run.promise;
      if (token.isCancellationRequested) return null;
      if (result.killed && !result.earlyExit) {
        logger.debug('inline.cancelled');
        return null;
      }
      if (result.exitCode !== null && result.exitCode !== 0 && !result.earlyExit) {
        logger.warn('inline.cliExitNonZero', {
          exit: result.exitCode,
          stderr: result.stderr.slice(0, 500)
        });
        this.statusBar.setError(`CLI exited with code ${result.exitCode}`);
        return null;
      }
      let raw = result.text;
      // Single-line mode: hard-trim everything past the first newline. The
      // streaming early-exit kills the subprocess at \n, but a \n may already
      // be in the buffer from the same chunk.
      if (shape === 'single-line') {
        const nl = raw.indexOf('\n');
        if (nl !== -1) raw = raw.slice(0, nl);
      }
      const cleaned = cleanCompletion({
        raw,
        followingText: suffix.slice(0, 200)
      });
      if (!cleaned) return null;
      logger.metric('inline.complete', {
        ms_first_token: result.msFirstToken,
        ms_total: result.msTotal,
        chars_raw: result.text.length,
        chars_clean: cleaned.length,
        shape: shape ?? ''
      });
      return cleaned;
    } catch (e) {
      logger.error('inline.error', { err: String(e) });
      this.statusBar.setError(String(e));
      return null;
    }
  }

  /** Resolves true if the timer fires, false if cancelled. */
  private delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (token.isCancellationRequested) return resolve(false);
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(true);
      }, ms);
      this.pendingDebounce = timer;
      const sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        if (this.pendingDebounce === timer) this.pendingDebounce = null;
        resolve(false);
      });
    });
  }
}

function makeList(text: string, position: vscode.Position): vscode.InlineCompletionList {
  const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  return { items: [item] };
}

function cacheKeysEqual(a: CompletionCacheKey, b: CompletionCacheKey): boolean {
  return (
    a.filename === b.filename &&
    a.languageId === b.languageId &&
    a.prefix === b.prefix &&
    a.suffix === b.suffix &&
    a.model === b.model &&
    a.mode === b.mode &&
    (a.shape ?? '') === (b.shape ?? '')
  );
}

// Per-URI cache for relative paths. Computing these involves
// vscode.workspace.getWorkspaceFolder() which is fast but allocates.
const RELPATH_CACHE = new Map<string, string>();

function relPath(document: vscode.TextDocument): string {
  const key = document.uri.toString();
  const hit = RELPATH_CACHE.get(key);
  if (hit !== undefined) return hit;
  const v = computeRelPath(document);
  if (RELPATH_CACHE.size > 256) RELPATH_CACHE.clear();
  RELPATH_CACHE.set(key, v);
  return v;
}

function computeRelPath(document: vscode.TextDocument): string {
  const ws = vscode.workspace.getWorkspaceFolder(document.uri);
  if (ws) {
    return path.relative(ws.uri.fsPath, document.uri.fsPath) || document.uri.fsPath;
  }
  const home = os.homedir();
  if (document.uri.fsPath.startsWith(home)) {
    return '~' + document.uri.fsPath.slice(home.length);
  }
  return document.uri.fsPath;
}

function workspaceCwd(document: vscode.TextDocument): string | undefined {
  const ws = vscode.workspace.getWorkspaceFolder(document.uri);
  return ws?.uri.fsPath;
}
