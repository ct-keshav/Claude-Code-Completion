import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export interface CliInfo {
  found: boolean;
  /** Absolute path. If the user passed `"claude"`, we resolve via $PATH/where. */
  resolvedPath?: string;
  version?: string;
  error?: string;
}

export async function detectCli(cliPath: string): Promise<CliInfo> {
  // First, resolve to an absolute path so the hot spawn path can skip
  // PATH lookup. This saves a few stat() syscalls per invocation.
  let absolute = cliPath;
  if (!path.isAbsolute(cliPath) && !cliPath.includes(path.sep)) {
    const which = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(which, [cliPath], { timeout: 3000 });
      const first = stdout.trim().split('\n')[0]?.trim();
      if (first) absolute = first;
    } catch {
      // fall through; we'll still try execFile with the original name
    }
  }
  try {
    const { stdout } = await execFileAsync(absolute, ['--version'], {
      timeout: 5000,
      env: process.env
    });
    return { found: true, resolvedPath: absolute, version: stdout.trim() };
  } catch (e: any) {
    return { found: false, error: e?.message || String(e) };
  }
}

export interface AuthCheck {
  authed: boolean;
  reason?: string;
}

/**
 * Quickly probe whether the CLI can run a real prompt under the user's session.
 * Strategy: invoke `claude -p "ok" --output-format stream-json` with a short
 * timeout; if we see any system/init or text event, we treat it as authed.
 *
 * We do NOT use --bare (forces API-key auth).
 */
export function probeAuth(cliPath: string, model: string, timeoutMs = 8000): Promise<AuthCheck> {
  return new Promise<AuthCheck>((resolve) => {
    let settled = false;
    const finish = (a: AuthCheck) => {
      if (!settled) {
        settled = true;
        resolve(a);
      }
    };

    let child;
    try {
      child = spawn(cliPath, [
        '-p', 'ok',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--max-turns', '1'
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (e: any) {
      return finish({ authed: false, reason: e?.message || String(e) });
    }

    let stderr = '';
    let sawSystem = false;
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      // If we already saw the init event, count that as authed; the rest of the
      // probe doesn't matter and we don't want to wait for full completion.
      finish(sawSystem
        ? { authed: true }
        : { authed: false, reason: 'probe timed out' });
    }, timeoutMs);

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (chunk.includes('"type":"system"') && chunk.includes('"subtype":"init"')) {
        sawSystem = true;
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => { stderr += c; });
    child.on('error', (e) => {
      clearTimeout(timeout);
      finish({ authed: false, reason: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (sawSystem && (code === 0 || code === null)) return finish({ authed: true });
      const lower = stderr.toLowerCase();
      if (/not logged in|oauth|unauthor|please log in|invalid_api_key/.test(lower)) {
        return finish({ authed: false, reason: stderr.trim().slice(0, 300) });
      }
      if (sawSystem) return finish({ authed: true });
      finish({ authed: false, reason: stderr.trim().slice(0, 300) || `exit ${code}` });
    });
  });
}

export async function signInFlow(cliPath: string): Promise<void> {
  const term = vscode.window.createTerminal({
    name: 'Claude Sign-In',
    isTransient: true
  });
  term.show(true);
  // Quote the cliPath so a value containing spaces / metacharacters can't
  // inject extra shell commands. POSIX-safe single-quoting: wrap in '...'
  // and escape any embedded single-quote with '\''.
  const quoted = shellQuote(cliPath);
  term.sendText(`${quoted} login || ${quoted}`);
  logger.info('auth.signInFlowOpened');
  vscode.window.showInformationMessage(
    'Run the Claude CLI in the terminal and complete the OAuth login. Then reload the window.',
    'Reload Window'
  ).then((choice) => {
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function shellQuote(s: string): string {
  // POSIX single-quote: wrap, and replace any embedded ' with '\''.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function notifyMissingCli(cliPath: string): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    `Claude CLI not found at "${cliPath}". Install it from the docs and re-enable Claude Inline Completions.`,
    'Install Claude Code',
    'Open Settings'
  );
  if (choice === 'Install Claude Code') {
    vscode.env.openExternal(vscode.Uri.parse('https://docs.claude.com/en/docs/claude-code/quickstart'));
  } else if (choice === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'claude.completions.cliPath');
  }
}
