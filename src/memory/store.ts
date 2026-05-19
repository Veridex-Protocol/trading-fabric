/**
 * @packageDocumentation
 * @module memory/store
 * @description Two `MemoryStore` implementations.
 *
 * - `InMemoryMemoryStore` — pure in-process state. Tests + ephemeral runs.
 * - `FileMemoryStore` — JSONL on disk with atomic rewrite via temp-file +
 *   rename. Lazy file creation; safe to point at a non-existent path.
 *
 * Concurrency: file-backed store serialises writes through an internal
 * promise chain. Multiple `TradingMemoryLog` instances targeting the
 * same file from the *same* process are safe; cross-process locking is
 * not provided.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { MemoryEntry, MemoryStore } from './types.js';

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(homedir(), p.slice(1));
  }
  return p;
}

// ── In-memory store ──────────────────────────────────────────────────────

export class InMemoryMemoryStore implements MemoryStore {
  private entries: MemoryEntry[] = [];

  constructor(initial: MemoryEntry[] = []) {
    this.entries = [...initial];
  }

  async loadAll(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }

  async append(entry: MemoryEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  async rewrite(entries: MemoryEntry[]): Promise<void> {
    this.entries = entries.map((e) => ({ ...e }));
  }
}

// ── File-backed JSONL store ──────────────────────────────────────────────

export class FileMemoryStore implements MemoryStore {
  readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = expandHome(filePath);
  }

  async loadAll(): Promise<MemoryEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: MemoryEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as MemoryEntry);
      } catch {
        // Skip malformed lines silently; a corrupted line should never
        // bring down a run, and partial-write recovery is exactly why
        // we use atomic rewrite.
      }
    }
    return entries;
  }

  async append(entry: MemoryEntry): Promise<void> {
    return this.serialise(async () => {
      await this.ensureDir();
      await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    });
  }

  async rewrite(entries: MemoryEntry[]): Promise<void> {
    return this.serialise(async () => {
      await this.ensureDir();
      const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  /** Run `op` after all prior writes complete; never reject the chain. */
  private serialise(op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
