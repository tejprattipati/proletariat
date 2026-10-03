import { describe, expect, it } from "vitest";
import type { Run } from "../../src/lib/types";
import { sortReceipts, summarizeReceiptUsage } from "../../src/lib/domain/receipts";

function receipt(id: string, fields: Partial<Run> = {}): Run {
  return { id, title: "Synthetic action", description: "Example receipt", status: "succeeded", createdAt: "2026-10-03T09:00:00Z", mode: "demo", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [], ...fields };
}

describe("receipt evidence", () => {
  it("sums only recorded receipt metrics and counts duplicate receipt IDs once", () => {
    const model = receipt("model", { modelCalls: 2, tokens: 345, apiCalls: 2 });
    const write = receipt("write", { apiCalls: 3, writes: 1, cacheHits: 1 });
    expect(summarizeReceiptUsage([model, write, model])).toEqual({ modelCalls: 2, tokens: 345, apiCalls: 5, writes: 1, cacheHits: 1 });
    expect(summarizeReceiptUsage([])).toEqual({ modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0 });
  });
  it("orders by timestamp with an ID tie-breaker, without mutating input", () => {
    const input = [receipt("b"), receipt("a"), receipt("new", { createdAt: "2026-10-03T10:00:00Z" })];
    expect(sortReceipts(input).map(run => run.id)).toEqual(["new", "a", "b"]);
    expect(sortReceipts([...input].reverse())).toEqual(sortReceipts(input));
    expect(input.map(run => run.id)).toEqual(["b", "a", "new"]);
  });
  it("retains usage from failed and uncertain attempts instead of counting successes only", () => {
    const attempts = [receipt("failed", { status: "failed", modelCalls: 1, apiCalls: 1 }), receipt("uncertain", { status: "unknown", apiCalls: 1 })];
    expect(summarizeReceiptUsage(attempts)).toMatchObject({ modelCalls: 1, apiCalls: 2, writes: 0 });
  });
});
