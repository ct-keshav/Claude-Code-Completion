import { spawn, ChildProcess } from 'node:child_process';
import { logger } from './logger';
import { StreamParser } from './streamParser';
import { getResolvedCliPath } from './resolvedCli';

export interface ClaudeRunOptions {
  cliPath: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  /** Called with each text delta as it streams in. Return `true` to terminate the run early. */
  onText?: (text: string, accumulated: string) => boolean | void;
  /** Optional caller-provided abort. The run also exposes its own .cancel(). */
  signal?: AbortSignal;
  /** Working directory for the subprocess. Defaults to CWD. */
  cwd?: string;
  /** Extra environment overrides. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Fast-mode env vars — these strip startup work without breaking OAuth.
 * Empirically (n=5+ runs each):
 *   - Without these: ~3.6s per request
 *   - With these:    ~1.2s per request
 * The biggest contributors are DISABLE_AUTO_MEMORY, DISABLE_CLAUDE_MDS, and
 * DISABLE_THINKING / DISABLE_ADAPTIVE_THINKING (which prevent the model
 * from inserting internal "thinking" tokens that would balloon latency).
 *
 * Do NOT add CLAUDE_CODE_SIMPLE=1 — that breaks keychain reads and forces
 * API-key auth.
 */
const FAST_MODE_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_THINKING: '1',
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
  CLAUDE_CODE_DISABLE_AGENTS_FLEET: '1'
};

/**
 * Build a slim environment for the child process. Most of process.env is
 * irrelevant to a one-shot CLI invocation; passing only what the binary
 * actually reads saves serialization time on Electron's enormous env.
 */
function buildSpawnEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passthrough = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'TMPDIR', 'TEMP', 'TMP',
    // SSL / proxy / network
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // macOS keychain access
    'SECURITYSESSIONID',
    // XDG dirs (config / cache locations)
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    // Windows essentials
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES',
    'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR'
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of passthrough) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // Pass through anything Claude-Code-specific the user might have set.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  }
  // Layer in fast-mode flags. User-set CLAUDE_CODE_DISABLE_* values from the
  // parent env take precedence (we already copied them above), so power users
  // can override.
  for (const [k, v] of Object.entries(FAST_MODE_ENV)) {
    if (env[k] === undefined) env[k] = v;
  }
  // Caller overrides win (used by tests).
  if (extra) Object.assign(env, extra);
  return env;
}

export interface ClaudeRunResult {
  text: string;
  exitCode: number | null;
  killed: boolean;
  stderr: string;
  /** ms from spawn to first text delta. -1 if no text was emitted. */
  msFirstToken: number;
  msTotal: number;
  earlyExit: boolean;
}

export class ClaudeRun {
  private child: ChildProcess | null = null;
  private killed = false;
  private done = false;
  private resolve!: (r: ClaudeRunResult) => void;
  private reject!: (e: Error) => void;
  readonly promise: Promise<ClaudeRunResult>;

  constructor(private opts: ClaudeRunOptions) {
    this.promise = new Promise<ClaudeRunResult>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  start(): void {
    const startedAt = Date.now();
    let firstTokenAt = -1;
    // Latency: --bare gives us the fastest startup but forces API-key auth,
    // which we can't use. The flags below approximate it without breaking
    // OAuth: skip MCP servers, skip user/project settings, skip skills, skip
    // tools, skip session-on-disk writes, and slim the system prompt.
    const args = [
      '-p', this.opts.userPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--system-prompt', this.opts.systemPrompt,
      '--model', this.opts.model,
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--tools', '',
      '--no-session-persistence',
      '--permission-mode', 'bypassPermissions'
    ];

    const resolvedPath = getResolvedCliPath(this.opts.cliPath);
    logger.debug('cli.spawn', { cliPath: resolvedPath, model: this.opts.model });

    let child: ChildProcess;
    try {
      child = spawn(resolvedPath, args, {
        cwd: this.opts.cwd,
        env: buildSpawnEnv(this.opts.env),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      this.reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.child = child;

    if (this.opts.signal) {
      if (this.opts.signal.aborted) {
        this.cancel();
      } else {
        this.opts.signal.addEventListener('abort', () => this.cancel(), { once: true });
      }
    }

    const parser = new StreamParser();
    let accumulated = '';
    let stderr = '';
    let earlyExit = false;

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const events = parser.feed(chunk);
      for (const ev of events) {
        if (ev.kind === 'text') {
          if (firstTokenAt === -1) firstTokenAt = Date.now();
          accumulated += ev.text;
          let stop = false;
          try {
            stop = this.opts.onText?.(ev.text, accumulated) === true;
          } catch (err) {
            logger.warn('cli.onText threw', { err: String(err) });
          }
          if (stop) {
            earlyExit = true;
            this.cancel();
            return;
          }
        } else if (ev.kind === 'error') {
          logger.warn('cli.streamError', { message: ev.message });
        } else if (ev.kind === 'stop' || ev.kind === 'result') {
          // surfaced via process exit
        }
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    child.on('error', (err) => {
      if (this.done) return;
      this.done = true;
      this.reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('close', (code, signal) => {
      if (this.done) return;
      this.done = true;
      const tail = parser.flush();
      for (const ev of tail) {
        if (ev.kind === 'text') accumulated += ev.text;
      }
      const msTotal = Date.now() - startedAt;
      const msFirstToken = firstTokenAt === -1 ? -1 : firstTokenAt - startedAt;
      logger.metric('cli.run', {
        ms_total: msTotal,
        ms_first_token: msFirstToken,
        chars: accumulated.length,
        exit: code,
        signal,
        killed: this.killed,
        early_exit: earlyExit
      });
      this.resolve({
        text: accumulated,
        exitCode: code,
        killed: this.killed,
        stderr,
        msFirstToken,
        msTotal,
        earlyExit
      });
    });
  }

  cancel(): void {
    if (this.done || this.killed) return;
    this.killed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch (e) {
      logger.warn('cli.cancel.sigterm-failed', { err: String(e) });
    }
    setTimeout(() => {
      if (!this.done && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          logger.warn('cli.cancel.sigkill-failed', { err: String(e) });
        }
      }
    }, 200);
  }
}

export const ClaudeCli = {
  run(opts: ClaudeRunOptions): ClaudeRun {
    const run = new ClaudeRun(opts);
    run.start();
    return run;
  }
};
