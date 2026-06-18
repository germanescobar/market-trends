/**
 * Tiny TTL cache used to keep the API snappy and stay polite to upstream
 * market data providers. Keyed by an arbitrary string.
 */
export class TTLCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  constructor(private ttlMs: number) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < now) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  /** Best-effort periodic cleanup. Safe to call on a timer. */
  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
  }
}
