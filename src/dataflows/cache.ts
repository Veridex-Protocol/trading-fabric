/**
 * @packageDocumentation
 * @module dataflows/cache
 * @description File-backed JSON cache with TTL. Used to memoize vendor
 * responses so a single agent run doesn't burn through paid-vendor quotas.
 *
 * Storage layout:
 * ```
 * <cacheDir>/<namespace>/<sha256(key)>.json
 * ```
 * Each entry is `{ key, ts, ttlMs, payload }`. Atomic writes via rename.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry<T> {
  key: string;
  ts: number;
  ttlMs: number;
  payload: T;
}

export interface CacheOptions {
  /** Root directory for cache files. */
  cacheDir: string;
  /** Logical namespace (e.g. 'yahoo', 'alpha_vantage'). */
  namespace: string;
  /** Default TTL in ms when not provided per-entry. */
  defaultTtlMs?: number;
}

export class FileCache {
  private readonly cacheDir: string;
  private readonly namespace: string;
  private readonly defaultTtlMs: number;
  private ensured = false;

  constructor(opts: CacheOptions) {
    this.cacheDir = opts.cacheDir;
    this.namespace = opts.namespace;
    this.defaultTtlMs = opts.defaultTtlMs ?? 60 * 60 * 1000; // 1h
  }

  private path(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.cacheDir, this.namespace, `${hash}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await mkdir(join(this.cacheDir, this.namespace), { recursive: true });
    this.ensured = true;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.path(key), 'utf8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (Date.now() - entry.ts > entry.ttlMs) return undefined;
      return entry.payload;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, payload: T, ttlMs?: number): Promise<void> {
    await this.ensureDir();
    const entry: CacheEntry<T> = {
      key,
      ts: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
      payload,
    };
    const target = this.path(key);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, target);
  }

  /** Convenience: `get` or compute-and-`set`. */
  async memo<T>(key: string, ttlMs: number | undefined, compute: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    await this.set(key, value, ttlMs);
    return value;
  }
}
