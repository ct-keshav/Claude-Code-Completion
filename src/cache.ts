import { createHash } from 'node:crypto';

interface Entry {
  value: string;
  expiresAt: number;
  derived?: boolean;
}

export interface CompletionCacheKey {
  filename: string;
  languageId: string;
  prefix: string;
  suffix: string;
  model: string;
  mode: 'inline' | 'intellisense';
  /** Completion length intent — single-line vs multi-line outputs are distinct cache entries. */
  shape?: 'single-line' | 'multi-line';
}

export class CompletionCache {
  private map = new Map<string, Entry>();

  constructor(private maxEntries: number = 100, private ttlMs: number = 60_000) {}

  static keyFor(k: CompletionCacheKey): string {
    const h = createHash('sha1');
    h.update(k.filename);
    h.update('\x1f');
    h.update(k.languageId);
    h.update('\x1f');
    h.update(hashString(k.prefix));
    h.update('\x1f');
    h.update(hashString(k.suffix));
    h.update('\x1f');
    h.update(k.model);
    h.update('\x1f');
    h.update(k.mode);
    h.update('\x1f');
    h.update(k.shape ?? '');
    return h.digest('hex');
  }

  get(k: CompletionCacheKey): string | undefined {
    const key = CompletionCache.keyFor(k);
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(k: CompletionCacheKey, value: string, opts?: { derived?: boolean; ttlMsOverride?: number }): void {
    if (!value) return;
    const key = CompletionCache.keyFor(k);
    const ttl = opts?.ttlMsOverride ?? this.ttlMs;
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      derived: opts?.derived
    });
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      if (!first) break;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Write derived cache entries for cursors 1..N characters deeper into the
   * suggestion. As the user types into the suggested text, each keystroke
   * produces a cache hit for the remaining tail — but only if the user typed
   * EXACTLY what was suggested. If they deviate at any point, the cache key
   * differs and we fall through to a fresh CLI call.
   *
   * Derived entries get a short TTL so a slightly-wrong completion doesn't
   * lock in for the full base TTL.
   */
  setWithShifts(
    k: CompletionCacheKey,
    value: string,
    opts?: { maxShift?: number; derivedTtlMs?: number }
  ): void {
    if (!value) return;
    const maxShift = opts?.maxShift ?? 15;
    const derivedTtlMs = opts?.derivedTtlMs ?? 10_000;
    this.set(k, value);
    const limit = Math.min(value.length - 1, maxShift);
    for (let i = 1; i <= limit; i++) {
      const typed = value.slice(0, i);
      const remaining = value.slice(i);
      if (!remaining) break;
      this.set(
        {
          ...k,
          prefix: k.prefix + typed
        },
        remaining,
        { derived: true, ttlMsOverride: derivedTtlMs }
      );
    }
  }
}

function hashString(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
