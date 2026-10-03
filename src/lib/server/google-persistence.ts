import type { GoogleDependencies, GoogleTokens, OperationRecord } from "../google/contracts";
import { deleteValue, finishOperation, getSecret, getValue, readWorkspace, reserveOperation, saveWorkspace, setSecret, setValue, transaction } from "./storage";
import type { WorkspaceState } from "../types";
function pauseForNewConnection(state: WorkspaceState) {
  if (state.settings.mode !== "live") return;
  for (const campaign of state.campaigns) if (["scheduled", "running"].includes(campaign.status)) campaign.status = "paused";
  for (const scan of state.scans) if (["queued", "running"].includes(scan.status)) scan.status = "paused";
  for (const workflow of state.workflows) if (workflow.mode === "automatic") workflow.enabled = false;
  state.runs.unshift({ id: `connection-${Date.now()}`, title: "Google connection changed", description: "Live campaigns, scans and automatic workflows were paused. Review their bindings before resuming with this connection.", status: "pending", createdAt: new Date().toISOString(), mode: "live", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [] });
}
export const googleDependencies: GoogleDependencies = {
  tokenStore: {
    async load() { return getSecret<GoogleTokens>("google:tokens"); },
    async save(tokens) {
      transaction(() => {
        const previous = getSecret<GoogleTokens>("google:tokens");
        if (tokens.connectionId && tokens.connectionId !== previous?.connectionId) {
          const active = readWorkspace("owner"); pauseForNewConnection(active); saveWorkspace("owner", active);
          const saved = getValue<WorkspaceState>("owner:saved:live");
          if (saved) { pauseForNewConnection(saved); setValue("owner:saved:live", saved); }
        }
        setSecret("google:tokens", tokens);
      });
    },
    async clear() { deleteValue("google:tokens"); },
  },
  store: {
    async get<T>(key: string) { return getValue<T>(`google:kv:${key}`); },
    async set<T>(key: string, value: T) { setValue(`google:kv:${key}`, value); },
    async delete(key) { deleteValue(`google:kv:${key}`); },
    async reserveOperation(key, fingerprint) {
      const claim=reserveOperation(`google:op:${key}`,fingerprint);
      const record=(claim.record.result as OperationRecord | undefined) || {fingerprint,status:"pending" as const};
      return {created:claim.reserved,record};
    },
    async finishOperation(key, record) { finishOperation(`google:op:${key}`,record,record.status==="unknown"?"unknown":"succeeded"); },
  },
  async getPermissions() { return readWorkspace("owner").permissions; },
};
