/**
 * @packageDocumentation
 * @module orchestration/structuredOutput
 * @description JSON extraction + Zod validation for structured-output
 * agents (Research Manager, Trader, Portfolio Manager).
 *
 * The prompts ask the model to emit raw JSON. In practice models often
 * wrap it in code fences or chatter — we tolerate both via a lenient
 * extractor that:
 *   1. Strips ```json ... ``` (or plain ```) fences.
 *   2. Falls back to the first balanced `{ ... }` substring.
 *   3. Parses + Zod-validates.
 *
 * On parse/validation failure we throw a `StructuredOutputError` carrying
 * the raw text so the orchestrator can surface it in the event log.
 */

import type { ZodSchema } from 'zod';

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

/** Extract the first plausible JSON object from a string. */
export function extractJsonString(raw: string): string {
  const trimmed = raw.trim();

  const fenced = FENCED_JSON.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  // Fall back: find the first '{' and walk to the matching '}'.
  const start = trimmed.indexOf('{');
  if (start === -1) return trimmed;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed;
}

/** Parse + validate a structured-output response. */
export function parseStructured<T>(raw: string, schema: ZodSchema<T>): T {
  const candidate = extractJsonString(raw);
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    throw new StructuredOutputError(
      `Failed to JSON.parse structured output: ${(err as Error).message}`,
      raw,
      err,
    );
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new StructuredOutputError(
      `Structured output failed Zod validation: ${result.error.message}`,
      raw,
      result.error,
    );
  }
  return result.data;
}
