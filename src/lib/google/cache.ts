import type { GoogleStore } from './contracts';

interface Entry { key: string; bytes: number; expiresAt: number; }
/** Disposable grant-scoped read cache. Never evicts bindings, OAuth state, cursors or write journals. */
export class GoogleReadCache {
  constructor(private store: GoogleStore, private now = () => new Date(), private maxEntries = 256, private maxBytes = 16 * 1024 * 1024) {}
  async get<T>(key: string): Promise<T | undefined> {
    const entries = await this.store.get<Entry[]>('read-cache-index') ?? [];
    const entry = entries.find(item => item.key === key);
    if (!entry || entry.expiresAt <= this.now().getTime()) {
      // Old, unindexed cache records are deliberately not reused across schema migration.
      await this.store.delete(key);
      return undefined;
    }
    return this.store.get<T>(key);
  }
  async set<T>(key: string, value: T, ttlMs = 300_000): Promise<void> {
    const now = this.now().getTime();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const prior = await this.store.get<Entry[]>('read-cache-index') ?? [];
    const entries: Entry[] = [];
    for (const entry of prior) {
      if (entry.key === key || entry.expiresAt <= now) await this.store.delete(entry.key);
      else entries.push(entry);
    }
    if (bytes <= this.maxBytes) {
      let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      while (entries.length >= this.maxEntries || total + bytes > this.maxBytes) {
        const oldest = entries.shift(); if (!oldest) break;
        total -= oldest.bytes; await this.store.delete(oldest.key);
      }
      await this.store.set(key, value);
      entries.push({ key, bytes, expiresAt: now + ttlMs });
    }
    await this.store.set('read-cache-index', entries);
  }
  async delete(key: string): Promise<void> {
    await this.store.delete(key);
    const entries = await this.store.get<Entry[]>('read-cache-index') ?? [];
    await this.store.set('read-cache-index', entries.filter(entry => entry.key !== key));
  }
}
