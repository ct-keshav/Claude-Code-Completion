interface LogChannel {
  appendLine(line: string): void;
  show?(preserveFocus?: boolean): void;
  dispose?(): void;
}

let channel: LogChannel | undefined;

function ensureChannel(): LogChannel {
  if (channel) return channel;
  // Lazy-resolve the vscode API; if we're running outside the extension host
  // (unit/integration tests), fall back to a console-backed channel so the
  // module remains importable.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    channel = vscode.window.createOutputChannel('Claude Inline Completions');
  } catch {
    channel = {
      appendLine: (line) => {
        if (process.env.CLAUDE_COMPLETIONS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(line);
        }
      }
    };
  }
  return channel!;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: string, msg: string, extra?: Record<string, unknown>): string {
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  return `[${ts()}] [${level}] ${msg}${tail}`;
}

export const logger = {
  info(msg: string, extra?: Record<string, unknown>): void {
    ensureChannel().appendLine(fmt('info', msg, extra));
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    ensureChannel().appendLine(fmt('warn', msg, extra));
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    ensureChannel().appendLine(fmt('error', msg, extra));
  },
  debug(msg: string, extra?: Record<string, unknown>): void {
    ensureChannel().appendLine(fmt('debug', msg, extra));
  },
  metric(name: string, fields: Record<string, unknown>): void {
    ensureChannel().appendLine(fmt('metric', name, fields));
  },
  show(): void {
    ensureChannel().show?.(true);
  },
  dispose(): void {
    channel?.dispose?.();
    channel = undefined;
  }
};
