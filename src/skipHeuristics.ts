import * as vscode from 'vscode';

export interface SkipContext {
  document: vscode.TextDocument;
  position: vscode.Position;
  enabledLanguages: string[];
  triggerKind: vscode.InlineCompletionTriggerKind;
  /** ms since this document was last modified. */
  msSinceLastEdit: number;
  /** Last keystroke was Backspace/Delete? */
  lastEditWasDeletion: boolean;
  /** True if running on battery and battery saver is enabled. */
  batterySaver: boolean;
  /** Active text selection length, if any. */
  selectionLength: number;
}

export type SkipReason =
  | 'disabled-language'
  | 'has-selection'
  | 'last-edit-deletion'
  | 'too-recent-edit'
  | 'whitespace-in-comment-or-string'
  | 'cursor-in-middle-of-identifier'
  | null;

export function shouldSkip(ctx: SkipContext): SkipReason {
  if (!ctx.enabledLanguages.includes(ctx.document.languageId)) {
    return 'disabled-language';
  }
  if (ctx.selectionLength > 0) {
    return 'has-selection';
  }
  if (
    ctx.lastEditWasDeletion &&
    ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
  ) {
    return 'last-edit-deletion';
  }

  // Cursor wedged inside an identifier (e.g. `foo|Bar` where | is cursor):
  // splitting that name with an inserted snippet is rarely what the user wants.
  const line = ctx.document.lineAt(ctx.position.line).text;
  const before = line.slice(0, ctx.position.character);
  const after = line.slice(ctx.position.character);
  if (/[A-Za-z0-9_]$/.test(before) && /^[A-Za-z0-9_]/.test(after)) {
    return 'cursor-in-middle-of-identifier';
  }

  return null;
}

export function adjustForBatterySaver(debounceMs: number, batterySaver: boolean): number {
  return batterySaver ? Math.max(debounceMs, 1200) : debounceMs;
}
