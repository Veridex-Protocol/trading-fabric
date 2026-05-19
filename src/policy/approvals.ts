/**
 * @packageDocumentation
 * @module policy/approvals
 * @description Human-in-the-loop approval queue. The orchestrator submits
 * an escalated proposal + verdicts; a human-driven surface (CLI / portal /
 * webhook) decides `approve` or `deny`; the orchestrator awaits that
 * decision and resumes.
 *
 * Two transports ship:
 *  - `InMemoryApprovalQueue` — for tests and single-process embedding.
 *  - `FileApprovalQueue`     — persists pending approvals as JSON in a
 *    directory so a separate process (CLI / control plane) can decide them.
 *
 * The queue is *content-addressable* only by `approvalId`. Idempotency
 * is the caller's job — submit twice and you get two approvals.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { Proposal, Verdict } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

/** Record persisted for one escalated proposal awaiting a human. */
export interface ApprovalRecord {
  id: string;
  /** Wall-clock ISO when the proposal was submitted. */
  createdAt: string;
  /** Wall-clock ISO when the decision was rendered. */
  resolvedAt: string | null;
  status: ApprovalStatus;
  proposal: Proposal;
  verdicts: Verdict[];
  /** Free-form reason supplied by the approver. */
  decisionNote: string | null;
}

export interface SubmitInput {
  proposal: Proposal;
  verdicts: Verdict[];
}

/**
 * Resolver returned by `submit`. Callers await `awaitDecision()` to block
 * until a human (or a test) writes a decision.
 */
export interface ApprovalHandle {
  id: string;
  /** Resolves when the queue receives a non-pending decision. */
  awaitDecision(): Promise<ApprovalRecord>;
}

export interface HumanApprovalQueue {
  submit(input: SubmitInput): Promise<ApprovalHandle>;
  decide(id: string, status: 'approved' | 'denied', note?: string): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  list(): Promise<ApprovalRecord[]>;
}

// ───────────────────────────────────────────────────────────────────────────
// In-memory implementation
// ───────────────────────────────────────────────────────────────────────────

interface PendingWaiter {
  resolve: (rec: ApprovalRecord) => void;
}

export interface InMemoryApprovalQueueOptions {
  idFactory?: () => string;
  now?: () => Date;
}

/**
 * Process-local approval queue. `await submit().awaitDecision()` returns
 * the resolved record. `decide()` flips status and wakes any waiters.
 */
export class InMemoryApprovalQueue implements HumanApprovalQueue {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(opts: InMemoryApprovalQueueOptions = {}) {
    this.idFactory = opts.idFactory ?? randomUUID;
    this.now = opts.now ?? (() => new Date());
  }

  async submit(input: SubmitInput): Promise<ApprovalHandle> {
    const id = this.idFactory();
    const record: ApprovalRecord = {
      id,
      createdAt: this.now().toISOString(),
      resolvedAt: null,
      status: 'pending',
      proposal: input.proposal,
      verdicts: input.verdicts,
      decisionNote: null,
    };
    this.records.set(id, record);
    return {
      id,
      awaitDecision: () => this.awaitInternal(id),
    };
  }

  private awaitInternal(id: string): Promise<ApprovalRecord> {
    const existing = this.records.get(id);
    if (existing && existing.status !== 'pending') {
      return Promise.resolve(existing);
    }
    return new Promise<ApprovalRecord>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ resolve });
      this.waiters.set(id, list);
    });
  }

  async decide(
    id: string,
    status: 'approved' | 'denied',
    note?: string,
  ): Promise<ApprovalRecord> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown approval id: ${id}`);
    if (rec.status !== 'pending') {
      throw new Error(`Approval ${id} already resolved as ${rec.status}`);
    }
    rec.status = status;
    rec.decisionNote = note ?? null;
    rec.resolvedAt = this.now().toISOString();
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const w of waiters) w.resolve(rec);
    return rec;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<ApprovalRecord[]> {
    return [...this.records.values()];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// File-backed implementation (one JSON per approval)
// ───────────────────────────────────────────────────────────────────────────

export interface FileApprovalQueueOptions {
  /** Directory used as the inbox. Will be created if missing. */
  dir: string;
  /** Poll interval in ms when waiting for a decision. Default 250. */
  pollMs?: number;
  idFactory?: () => string;
  now?: () => Date;
}

/**
 * Disk-backed approval queue. Each approval is a JSON file named `<id>.json`
 * in `dir`. A separate process (CLI / portal) rewrites the file with
 * `status: 'approved' | 'denied'` to release the waiter.
 *
 * Polling is deliberately simple — approvals are rare and human-paced.
 */
export class FileApprovalQueue implements HumanApprovalQueue {
  private readonly dir: string;
  private readonly pollMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(opts: FileApprovalQueueOptions) {
    this.dir = opts.dir;
    this.pollMs = opts.pollMs ?? 250;
    this.idFactory = opts.idFactory ?? randomUUID;
    this.now = opts.now ?? (() => new Date());
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async writeRecord(rec: ApprovalRecord): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.filePath(rec.id)}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath(rec.id));
  }

  private async readRecord(id: string): Promise<ApprovalRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as ApprovalRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async submit(input: SubmitInput): Promise<ApprovalHandle> {
    const id = this.idFactory();
    const rec: ApprovalRecord = {
      id,
      createdAt: this.now().toISOString(),
      resolvedAt: null,
      status: 'pending',
      proposal: input.proposal,
      verdicts: input.verdicts,
      decisionNote: null,
    };
    await this.writeRecord(rec);
    return {
      id,
      awaitDecision: () => this.poll(id),
    };
  }

  private async poll(id: string): Promise<ApprovalRecord> {
    for (;;) {
      const rec = await this.readRecord(id);
      if (rec && rec.status !== 'pending') return rec;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async decide(
    id: string,
    status: 'approved' | 'denied',
    note?: string,
  ): Promise<ApprovalRecord> {
    const rec = await this.readRecord(id);
    if (!rec) throw new Error(`Unknown approval id: ${id}`);
    if (rec.status !== 'pending') {
      throw new Error(`Approval ${id} already resolved as ${rec.status}`);
    }
    rec.status = status;
    rec.decisionNote = note ?? null;
    rec.resolvedAt = this.now().toISOString();
    await this.writeRecord(rec);
    return rec;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.readRecord(id);
  }

  async list(): Promise<ApprovalRecord[]> {
    try {
      const names = await fs.readdir(this.dir);
      const out: ApprovalRecord[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(this.dir, name), 'utf8');
        out.push(JSON.parse(raw) as ApprovalRecord);
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
