import type { Run } from "../types";

export type ReceiptUsage = Pick<Run, "modelCalls" | "tokens" | "apiCalls" | "writes" | "cacheHits">;

/** Count recorded usage once per receipt. Never substitute workspace-wide counters. */
export function summarizeReceiptUsage(receipts: readonly Run[]): ReceiptUsage {
  const seen = new Set<string>();
  const usage: ReceiptUsage = { modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0 };
  for (const receipt of receipts) {
    if (seen.has(receipt.id)) continue;
    seen.add(receipt.id);
    for (const field of ["modelCalls", "tokens", "apiCalls", "writes", "cacheHits"] as const) usage[field] += receipt[field];
  }
  return usage;
}

/** Newest first, with a stable ID tie-breaker so card ordering never depends on array order. */
export function sortReceipts(receipts: readonly Run[]): Run[] {
  const byId = new Map<string, Run>();
  for (const receipt of receipts) if (!byId.has(receipt.id)) byId.set(receipt.id, receipt);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}
