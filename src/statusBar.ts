import * as vscode from 'vscode';

export type StatusBarState = 'ready' | 'thinking' | 'error' | 'disabled' | 'unauth';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private resetTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claude.completions.openLogs';
    this.setReady();
    this.item.show();
  }

  setReady(): void {
    this.clearReset();
    this.item.text = '$(sparkle) Claude';
    this.item.tooltip = 'Claude inline completions: ready. Click to open logs.';
    this.item.backgroundColor = undefined;
  }

  setThinking(): void {
    this.clearReset();
    this.item.text = '$(sync~spin) Claude';
    this.item.tooltip = 'Claude is thinking…';
    this.item.backgroundColor = undefined;
    // Auto-fall back to ready if we forget to clear it.
    this.resetTimer = setTimeout(() => this.setReady(), 30_000);
  }

  setError(message: string): void {
    this.clearReset();
    this.item.text = '$(error) Claude';
    this.item.tooltip = `Claude error: ${message}\nClick to open logs.`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.resetTimer = setTimeout(() => this.setReady(), 8_000);
  }

  setDisabled(): void {
    this.clearReset();
    this.item.text = '$(circle-slash) Claude';
    this.item.tooltip = 'Claude inline completions: disabled. Click to open logs.';
    this.item.backgroundColor = undefined;
  }

  setUnauth(): void {
    this.clearReset();
    this.item.text = '$(key) Claude';
    this.item.tooltip = 'Claude is not signed in. Click to sign in.';
    this.item.command = 'claude.completions.signIn';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    this.clearReset();
    this.item.dispose();
  }

  private clearReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    // Restore the default click target if we previously hijacked it for sign-in.
    if (this.item.command !== 'claude.completions.openLogs') {
      this.item.command = 'claude.completions.openLogs';
    }
  }
}
