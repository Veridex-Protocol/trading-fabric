/**
 * Tiny zero-dependency `.env` loader for the CLI entry. The library
 * itself remains pure (callers pass `env` explicitly); this helper
 * only runs when the CLI is invoked without an injected `env`, so
 * tests and embedders are unaffected.
 *
 * Rules:
 *  - Reads `<cwd>/.env` (or the path passed in).
 *  - `KEY=VALUE` lines, comments (`#`), and blank lines.
 *  - Surrounding single/double quotes on the value are stripped.
 *  - Existing `process.env` values are NEVER overwritten — shell-level
 *    exports always win.
 *  - Missing file is a no-op (no throw, no log).
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface LoadDotenvOptions {
  /** Absolute or cwd-relative path. Defaults to `<cwd>/.env`. */
  path?: string;
  /** Target env object (defaults to `process.env`). */
  target?: NodeJS.ProcessEnv;
  /** Working dir for path resolution. Defaults to `process.cwd()`. */
  cwd?: string;
}

export function loadDotenvFromCwd(options: LoadDotenvOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const file = path.resolve(cwd, options.path ?? '.env');
  const target = options.target ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || target[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}
