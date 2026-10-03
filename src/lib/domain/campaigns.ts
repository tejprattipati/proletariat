import type { Campaign, CampaignRecipient, WorkspaceState } from "../types";
import { assert, operationKey, stableId } from "./core";
import { requirePermission } from "./workflows";

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  assert(email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email) && !email.includes(".."), "Use a single valid email address.");
  return email;
}

export function recipientOperationKey(campaignId: string, email: string): string {
  return operationKey("campaign-delivery", campaignId, normalizeEmail(email));
}

export function deduplicateRecipients(campaignId: string, input: Array<{ email: string; name?: string }>): CampaignRecipient[] {
  assert(input.length > 0 && input.length <= 10000, "Campaigns require between 1 and 10000 recipients.");
  const recipients = new Map<string, CampaignRecipient>();
  for (const item of input) {
    assert(typeof item.email === "string", "Every recipient needs an email address.");
    const email = normalizeEmail(item.email);
    if (!recipients.has(email)) recipients.set(email, { id: stableId("recipient", campaignId, email), email, name: item.name?.trim() ?? "", status: "pending" });
  }
  return [...recipients.values()];
}

export function transitionCampaign(campaign: Campaign, action: "start" | "pause" | "resume" | "cancel"): void {
  if (action === "cancel") {
    assert(campaign.status !== "completed", "A completed campaign cannot be cancelled.");
    campaign.status = "cancelled";
    return;
  }
  const allowed = action === "start" ? ["draft", "scheduled"] : action === "pause" ? ["running", "scheduled"] : ["paused"];
  assert(allowed.includes(campaign.status), `Cannot ${action} a ${campaign.status} campaign.`);
  campaign.status = action === "pause" ? "paused" : "running";
}

/** Synthetic dispatch only. Unknown outcomes are never eligible for a retry. */
export function dispatchDemoCampaign(state: WorkspaceState, campaignId: string, now: Date): WorkspaceState {
  const next = structuredClone(state);
  const campaign = next.campaigns.find(item => item.id === campaignId);
  assert(campaign, "Campaign was not found.", "NOT_FOUND");
  assert(next.settings.mode === "demo" && campaign.mode === "demo", "Live campaigns require the Google adapter.", "LIVE_ADAPTER_REQUIRED");
  requirePermission(next.permissions, "send", "bulkSend");
  if (campaign.status !== "running") return next;
  assert(Number.isFinite(now.getTime()), "A valid dispatch time is required.");
  assert(Number.isInteger(campaign.ratePerMinute) && campaign.ratePerMinute > 0 && campaign.ratePerMinute <= 1000, "Campaign rate must be an integer between 1 and 1000.");
  if (campaign.scheduledAt) assert(/(?:Z|[+-]\d{2}:\d{2})$/i.test(campaign.scheduledAt) && Number.isFinite(Date.parse(campaign.scheduledAt)), "Campaign schedule must be an ISO timestamp with offset.");
  if (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > now.getTime()) {
    campaign.status = "scheduled";
    return next;
  }
  const window = Math.floor(now.getTime() / 60_000);
  const ratePrefix = operationKey("campaign-rate", campaign.id, window);
  let used = next.processedKeys.filter(key => key.startsWith(`${ratePrefix}:`)).length;
  for (const recipient of campaign.recipients) {
    if (recipient.status !== "pending") continue;
    const key = recipientOperationKey(campaign.id, recipient.email);
    if (next.processedKeys.includes(key)) { recipient.status = "accepted"; continue; }
    if (used >= campaign.ratePerMinute) break;
    recipient.status = "accepted";
    recipient.externalId = stableId("demo-delivery", campaign.id, recipient.email);
    next.processedKeys.push(key, `${ratePrefix}:${++used}`);
  }
  if (campaign.recipients.every(recipient => recipient.status !== "pending")) campaign.status = campaign.recipients.some(recipient => recipient.status === "unknown" || recipient.status === "failed") ? "paused" : "completed";
  return next;
}
