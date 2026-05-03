import * as vscode from 'vscode';
import { getConfig, updateConfig } from './config';
import { signInFlow } from './auth';
import { logger } from './logger';
import { InlineProvider } from './inlineProvider';

export interface CommandDeps {
  inlineProvider: InlineProvider;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand('claude.completions.toggle', async () => {
      const cfg = getConfig();
      const next = !cfg.enabled;
      await updateConfig('enabled', next);
      vscode.window.showInformationMessage(`Claude inline completions ${next ? 'enabled' : 'disabled'}.`);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('claude.completions.triggerNow', async () => {
      // Asks VS Code to re-trigger inline suggestions in the active editor.
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    })
  );

  disposables.push(
    vscode.commands.registerCommand('claude.completions.clearCache', () => {
      deps.inlineProvider.clearCache();
      vscode.window.showInformationMessage('Claude completion cache cleared.');
    })
  );

  disposables.push(
    vscode.commands.registerCommand('claude.completions.openLogs', () => {
      logger.show();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('claude.completions.signIn', async () => {
      const cfg = getConfig();
      await signInFlow(cfg.cliPath);
    })
  );

  return disposables;
}
