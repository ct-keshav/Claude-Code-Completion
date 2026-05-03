import * as vscode from 'vscode';
import { getConfig, onConfigChange, CompletionsConfig } from './config';
import { setResolvedCliPath, clearResolvedCliPath } from './resolvedCli';
import { logger } from './logger';
import { StatusBar } from './statusBar';
import { InlineProvider } from './inlineProvider';
import { IntellisenseProvider } from './completionProvider';
import { registerCommands } from './commands';
import { detectCli, probeAuth, notifyMissingCli } from './auth';

let activeConfig: CompletionsConfig;
let statusBar: StatusBar;
let inlineProvider: InlineProvider;
let intellisenseProvider: IntellisenseProvider;
let inlineRegistration: vscode.Disposable | undefined;
let intellisenseRegistration: vscode.Disposable | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.info('activate');

  activeConfig = getConfig();
  statusBar = new StatusBar();

  inlineProvider = new InlineProvider(() => activeConfig, statusBar);
  intellisenseProvider = new IntellisenseProvider(() => activeConfig);

  registerProviders(activeConfig);

  context.subscriptions.push(
    statusBar,
    inlineProvider,
    ...registerCommands({ inlineProvider }),
    onConfigChange((cfg) => {
      const prev = activeConfig;
      activeConfig = cfg;
      logger.info('config.changed');
      if (prev.cliPath !== cfg.cliPath) {
        clearResolvedCliPath();
        // Re-resolve in the background. New requests in the meantime will
        // spawn via the configured name (correct, just slightly slower).
        void runStartupChecks();
      }
      if (
        prev.enableInline !== cfg.enableInline ||
        prev.enableIntellisense !== cfg.enableIntellisense ||
        prev.enabled !== cfg.enabled ||
        !arraysEqual(prev.languages, cfg.languages)
      ) {
        registerProviders(cfg);
      }
      if (!cfg.enabled) {
        statusBar.setDisabled();
      } else {
        statusBar.setReady();
      }
    })
  );

  if (!activeConfig.enabled) {
    statusBar.setDisabled();
    return;
  }

  // Defer the CLI presence + auth check so activation stays snappy.
  void runStartupChecks();
}

export function deactivate(): void {
  logger.info('deactivate');
  // inlineProvider, statusBar, command disposables are handled via
  // context.subscriptions. Just clean up the bare provider registrations
  // (added/removed dynamically on config change, not via subscriptions)
  // and the logger.
  inlineRegistration?.dispose();
  intellisenseRegistration?.dispose();
  logger.dispose();
}

function registerProviders(cfg: CompletionsConfig): void {
  inlineRegistration?.dispose();
  intellisenseRegistration?.dispose();
  inlineRegistration = undefined;
  intellisenseRegistration = undefined;

  if (!cfg.enabled) return;

  const selector: vscode.DocumentSelector = cfg.languages.map((lang) => ({
    scheme: 'file',
    language: lang
  }));

  if (cfg.enableInline) {
    inlineRegistration = vscode.languages.registerInlineCompletionItemProvider(
      selector,
      inlineProvider
    );
  }
  if (cfg.enableIntellisense) {
    intellisenseRegistration = vscode.languages.registerCompletionItemProvider(
      selector,
      intellisenseProvider
    );
  }
}

async function runStartupChecks(): Promise<void> {
  const cli = await detectCli(activeConfig.cliPath);
  if (!cli.found) {
    logger.warn('startup.cliMissing', { cliPath: activeConfig.cliPath, error: cli.error });
    statusBar.setError('Claude CLI not found');
    void notifyMissingCli(activeConfig.cliPath);
    return;
  }
  if (cli.resolvedPath) {
    setResolvedCliPath(activeConfig.cliPath, cli.resolvedPath);
  }
  logger.info('startup.cliFound', { version: cli.version, resolved: cli.resolvedPath });

  const auth = await probeAuth(activeConfig.cliPath, activeConfig.model).catch((e) => ({
    authed: false,
    reason: String(e)
  }));
  if (!auth.authed) {
    logger.warn('startup.authProbeFailed', { reason: auth.reason });
    statusBar.setUnauth();
    const choice = await vscode.window.showWarningMessage(
      'Claude is not signed in. Sign in to enable inline completions.',
      'Sign In',
      'Dismiss'
    );
    if (choice === 'Sign In') {
      await vscode.commands.executeCommand('claude.completions.signIn');
    }
    return;
  }
  statusBar.setReady();
  logger.info('startup.ready');
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
