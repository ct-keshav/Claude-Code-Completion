import * as vscode from 'vscode';

const SECTION = 'claude.completions';

export interface CompletionsConfig {
  enabled: boolean;
  cliPath: string;
  model: string;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  maxOutputTokens: number;
  languages: string[];
  enableInline: boolean;
  enableIntellisense: boolean;
  batterySaver: boolean;
}

export function getConfig(): CompletionsConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: c.get<boolean>('enabled', true),
    cliPath: getTrustedCliPath(c),
    model: c.get<string>('model', 'claude-sonnet-4-6'),
    debounceMs: c.get<number>('debounceMs', 250),
    maxPrefixChars: c.get<number>('maxPrefixChars', 1500),
    maxSuffixChars: c.get<number>('maxSuffixChars', 400),
    maxOutputTokens: c.get<number>('maxOutputTokens', 128),
    languages: c.get<string[]>('languages', []),
    enableInline: c.get<boolean>('enableInline', true),
    enableIntellisense: c.get<boolean>('enableIntellisense', false),
    batterySaver: c.get<boolean>('batterySaver', true)
  };
}

/**
 * Spawn-safety: a malicious workspace could ship `.vscode/settings.json` with
 * a `claude.completions.cliPath` pointing at a binary inside the repo. We
 * only honor `cliPath` from User (global) settings — workspace and
 * workspace-folder values are ignored with a warning.
 *
 * The fallback default ("claude") is always considered safe — it goes
 * through normal $PATH resolution which the user controls.
 */
function getTrustedCliPath(c: vscode.WorkspaceConfiguration): string {
  const inspect = c.inspect<string>('cliPath');
  if (!inspect) return 'claude';
  // Precedence: User > default. Explicitly DO NOT use workspaceValue or
  // workspaceFolderValue.
  if (typeof inspect.globalValue === 'string' && inspect.globalValue.length > 0) {
    return inspect.globalValue;
  }
  if (
    typeof inspect.workspaceValue === 'string' ||
    typeof inspect.workspaceFolderValue === 'string'
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[claude-completions] Ignoring workspace-scoped cliPath override for security. Set this in User settings instead.'
    );
  }
  return inspect.defaultValue ?? 'claude';
}

export function onConfigChange(handler: (cfg: CompletionsConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      handler(getConfig());
    }
  });
}

export async function updateConfig<K extends keyof CompletionsConfig>(
  key: K,
  value: CompletionsConfig[K],
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}
