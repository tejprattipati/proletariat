import { DateTime, IANAZone } from "luxon";

export class DomainError extends Error {
  constructor(message: string, public code = "VALIDATION_ERROR") {
    super(message);
    this.name = "DomainError";
  }
}

export function assert(condition: unknown, message: string, code?: string): asserts condition {
  if (!condition) throw new DomainError(message, code);
}

export function localDate(now: Date, timezone: string): string {
  const value = DateTime.fromJSDate(now, { zone: timezone });
  assert(value.isValid, "A valid date and IANA timezone are required.");
  return value.toISODate()!;
}

export function validateDate(value: string): string {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: "UTC" }).isValid, "Use a valid YYYY-MM-DD date.");
  return value;
}

export function validateTimezone(value: string): string {
  assert(IANAZone.isValidZone(value), "Use a valid IANA timezone.");
  return value;
}

/** Stable, non-secret IDs. Identity tuples are framed by JSON to avoid delimiter ambiguity. */
export function stableId(prefix: string, ...parts: unknown[]): string {
  const value = JSON.stringify(parts);
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `${prefix}_${hash.toString(16).padStart(16, "0")}`;
}

export function operationKey(kind: string, ...parts: unknown[]): string {
  return `${kind}:${JSON.stringify(parts)}`;
}

export function text(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  assert(typeof value === "string" && value.trim().length > 0, `${field} is required.`);
  return value.trim();
}

export function finiteNumber(value: unknown, field: string, fallback: number, min = 1, max = 10080): number {
  if (value === undefined) return fallback;
  assert(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, `${field} must be between ${min} and ${max}.`);
  return value;
}

export function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
