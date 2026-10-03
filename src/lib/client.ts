import type { ActionRequest, ActionResult, WorkspaceState } from "./types";
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
let ownerKeyInMemory = "";
export const getOwnerKey = () => ownerKeyInMemory;
export function setOwnerKey(value: string) { ownerKeyInMemory = value; }
function workspaceId() { let id = localStorage.getItem("proletariat-workspace-id"); if (!id) { id = crypto.randomUUID(); localStorage.setItem("proletariat-workspace-id", id); } return id; }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const ownerKey = getOwnerKey();
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", "X-Workspace-ID": workspaceId(), ...(ownerKey ? {Authorization: `Bearer ${ownerKey}`} : {}), ...init?.headers } });
  const data = await response.json().catch(() => ({ error: "The backend did not return JSON. Check the connection URL." }));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data as T;
}
export const getWorkspace = () => api<WorkspaceState>("/api/workspace");
export const act = (action: ActionRequest) => api<ActionResult>("/api/action", { method: "POST", body: JSON.stringify({ ...action, requestId: action.requestId || crypto.randomUUID() }) });
export const chat = (agentId: string, message: string, taskId?: string) => api<ActionResult>("/api/chat", { method: "POST", body: JSON.stringify({ agentId, message, taskId }) });
