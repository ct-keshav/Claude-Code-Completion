/**
 * Process-wide cache for the resolved (absolute) Claude CLI path.
 *
 * Spawning by name (`"claude"`) makes the OS do PATH resolution on every
 * invocation — a few stat() syscalls per spawn. Once we've resolved the
 * binary at startup, all subsequent spawns use the absolute path directly.
 *
 * The cache is keyed by the user-configured cliPath so that toggling between
 * different binaries via settings still works correctly.
 */

const cache = new Map<string, string>();

export function setResolvedCliPath(configured: string, resolved: string): void {
  cache.set(configured, resolved);
}

export function getResolvedCliPath(configured: string): string {
  return cache.get(configured) ?? configured;
}

export function clearResolvedCliPath(): void {
  cache.clear();
}
