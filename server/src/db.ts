import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

export const prisma = new PrismaClient();

export interface CorruptRecordRef {
  readonly model: string;
  readonly id: string;
  readonly field: string;
}

export class CorruptRecordError extends Error {
  readonly status = 500;
  readonly record: CorruptRecordRef;

  constructor(record: CorruptRecordRef, cause?: unknown) {
    super(`Corrupt stored JSON in ${record.model}.${record.field}`);
    this.name = 'CorruptRecordError';
    this.record = record;
    if (cause instanceof Error) this.cause = cause;
  }
}

// Small helpers for the JSON-as-string columns.
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const warnedJsonRecords = new Set<string>();

export function parseJsonOptional<T>(value: string | null | undefined, fallback: T, record: CorruptRecordRef): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    const key = `${record.model}:${record.id}:${record.field}`;
    if (!warnedJsonRecords.has(key)) {
      warnedJsonRecords.add(key);
      logger.warn(record, 'Optional stored JSON is unreadable; using fallback');
    }
    return fallback;
  }
}

export function parseJsonStrict<T>(value: string | null | undefined, record: CorruptRecordRef): T {
  if (!value) throw new CorruptRecordError(record);
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    throw new CorruptRecordError(record, err);
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
