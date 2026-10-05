import type { ActionRequest, ActionResult, WorkspaceState } from "./types";
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
let ownerKeyInMemory = "";
export const getOwnerKey = () => ownerKeyInMemory;
export function setOwnerKey(value: string) { ownerKeyInMemory = value; }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const ownerKey = getOwnerKey();
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(ownerKey ? {Authorization: `Bearer ${ownerKey}`} : {}), ...init?.headers } });
  const data = await response.json().catch(() => ({ error: "The backend did not return JSON. Check the connection URL." }));
  if (!response.ok) { if(response.status===401 && !path.startsWith("/api/identity") && typeof window!=="undefined") window.dispatchEvent(new Event("proletariat-session-expired")); throw new Error(data.error || "Request failed"); }
  return data as T;
}
export const getWorkspace = () => api<WorkspaceState>("/api/workspace");
export const act = (action: ActionRequest) => api<ActionResult>("/api/action", { method: "POST", body: JSON.stringify({ ...action, requestId: action.requestId || crypto.randomUUID() }) });
export const chat = (agentId: string, message: string, taskId?: string) => api<ActionResult>("/api/chat", { method: "POST", body: JSON.stringify({ agentId, message, taskId }) });

export const sendConversationMessage = (conversationId: string, message: string, attachmentIds?: string[]) => api<ActionResult>("/api/chat", {method:"POST",body:JSON.stringify({conversationId,message,attachmentIds})});
export function uploadAttachment(file: File, conversationId: string) {
  const query = new URLSearchParams({conversationId,name:file.name,mime:file.type || "application/octet-stream"});
  return api<ActionResult>(`/api/attachments/upload?${query}`, {method:"POST",headers:{"Content-Type":"application/octet-stream"},body:file});
}
