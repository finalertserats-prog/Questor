import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Small helpers for the JSON-as-string columns.
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
