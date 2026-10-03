import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/lib/domain/actions";
import { deduplicateRecipients, dispatchDemoCampaign, normalizeEmail, recipientOperationKey, transitionCampaign } from "../../src/lib/domain/campaigns";
import { now, workspace } from "./helpers";

function prepared() {
  const state = workspace(); state.permissions.send = true; state.permissions.bulkSend = true;
  return applyAction(state, { type: "campaign.create", payload: { name: "Example outreach", subject: "Example update", body: "Synthetic message", ratePerMinute: 1,
    recipients: [{ email: " ALEX@example.com ", name: "Alex" }, { email: "alex@example.com" }, { email: "casey@example.com" }] } }, now);
}

describe("safe campaign recipients", () => {
  it("deduplicates case/whitespace without collapsing distinct plus addresses", () => {
    const recipients = deduplicateRecipients("campaign-one", [{ email: " Alex@EXAMPLE.com " }, { email: "alex@example.com" }, { email: "alex+team@example.com" }]);
    expect(recipients.map(value => value.email)).toEqual(["alex@example.com", "alex+team@example.com"]);
    expect(recipientOperationKey("one", " Alex@EXAMPLE.com ")).toBe(recipientOperationKey("one", "alex@example.com"));
    expect(recipientOperationKey("one", "alex@example.com")).not.toBe(recipientOperationKey("two", "alex@example.com"));
  });
  it.each(["alex@example.com\nBcc:casey@example.com", "Alex <alex@example.com>", "alex@example.com,casey@example.com", "no-at-sign", "alex@bad..example.com"])("rejects invalid or multiple recipient address %s", email => {
    expect(() => normalizeEmail(email)).toThrow();
  });
});

describe("campaign execution", () => {
  it("deduplicates delivery operations and enforces per-minute rate across repeated calls", () => {
    const created = prepared();
    const started = applyAction(created.state, { type: "campaign.start", payload: { id: created.entityId } }, now).state;
    expect(started.campaigns[0].recipients.map(value => value.status)).toEqual(["accepted", "pending"]);
    expect(dispatchDemoCampaign(started, created.entityId!, now)).toEqual(started);
    const complete = dispatchDemoCampaign(started, created.entityId!, new Date("2026-10-03T08:01:00Z"));
    expect(complete.campaigns[0].status).toBe("completed");
    expect(complete.processedKeys.filter(key => key.startsWith("campaign-delivery:"))).toHaveLength(2);
    expect(dispatchDemoCampaign(complete, created.entityId!, new Date("2026-10-03T08:02:00Z"))).toEqual(complete);
  });
  it("rechecks global send and bulk permissions after queue creation and on resume", () => {
    const created = prepared(); created.state.permissions.send = false;
    expect(() => applyAction(created.state, { type: "campaign.start", payload: { id: created.entityId } }, now)).toThrow(/send/);
    created.state.permissions.send = true;
    const started = applyAction(created.state, { type: "campaign.start", payload: { id: created.entityId } }, now).state;
    const paused = applyAction(started, { type: "campaign.pause", payload: { id: created.entityId } }, now).state;
    paused.permissions.bulkSend = false;
    expect(() => applyAction(paused, { type: "campaign.resume", payload: { id: created.entityId } }, now)).toThrow(/bulkSend/);
    started.permissions.send = false;
    expect(() => dispatchDemoCampaign(started, created.entityId!, now)).toThrow(/send/);
  });
  it("never resends unknown outcomes or calls them successful completion", () => {
    const created = prepared(); const campaign = created.state.campaigns[0]; campaign.status = "running";
    campaign.recipients[0].status = "unknown"; campaign.recipients[1].status = "excluded";
    const result = dispatchDemoCampaign(created.state, campaign.id, now);
    expect(result.campaigns[0].recipients[0].status).toBe("unknown");
    expect(result.campaigns[0].status).toBe("paused");
    expect(result.processedKeys).toHaveLength(0);
  });
  it("does not send future-scheduled recipients", () => {
    const created = prepared(); const campaign = created.state.campaigns[0]; campaign.scheduledAt = "2026-10-04T08:00:00Z";
    const result = applyAction(created.state, { type: "campaign.start", payload: { id: created.entityId } }, now);
    expect(result.state.campaigns[0].status).toBe("scheduled");
    expect(result.state.campaigns[0].recipients.every(value => value.status === "pending")).toBe(true);
  });
  it("rejects invalid transitions and malformed persisted scheduling configuration", () => {
    const created = prepared(); const campaign = created.state.campaigns[0];
    expect(() => transitionCampaign(campaign, "resume")).toThrow();
    transitionCampaign(campaign, "cancel");
    expect(() => transitionCampaign(campaign, "start")).toThrow();
    campaign.status = "running"; campaign.scheduledAt = "bad-date";
    expect(() => dispatchDemoCampaign(created.state, campaign.id, now)).toThrow(/schedule/);
  });
  it("allows live queue creation and cancellation without simulating a live send", () => {
    const state = prepared().state; state.settings.mode = "live"; state.campaigns[0].mode = "live";
    const result = applyAction(state, { type: "campaign.create", payload: { name: "Example live queue", subject: "Example", body: "Example", recipients: [{ email: "alex@example.com" }] } }, now);
    expect(result.state.campaigns[1].mode).toBe("live");
    expect(() => applyAction(result.state, { type: "campaign.start", payload: { id: result.entityId } }, now)).toThrow(/adapter/);
    expect(applyAction(result.state, { type: "campaign.cancel", payload: { id: result.entityId } }, now).state.campaigns[1].status).toBe("cancelled");
  });
});
