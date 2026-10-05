import type { GoogleDependencies, GoogleTokens, OperationRecord } from "../google/contracts";
import { deleteValue, finishOperation, getSecret, getValue, readWorkspace, reserveOperation, saveWorkspace, setSecret, setValue, transaction, withWorkspace } from "./storage";
import type { WorkspaceState } from "../types";
import { extractPdfText } from "./attachments";
import { GoogleSignIn } from "../google/identity";
import { configFromEnv } from "../google/oauth";
import { archiveProviderTasks, restoreProviderTasks } from './provider-task-archive';
export function pauseForNewConnection(state: WorkspaceState, userId="owner", preserveTasks=false) {
  if (state.settings.mode !== "live") return;
  const now = new Date().toISOString();
  // Preserve the old workspace privately for reconciliation, but never supply its
  // remote content to a model running against a different OAuth grant.
  setValue(`${userId}:google-context-archive:${now}:${state.version}`, structuredClone(state));
  state.googleContextResetAt = now;
  const sourceIds = new Set([...(state.daily?.sources.map(source=>source.id)??[]), ...state.resources.map(resource=>resource.id)]);
  if(!preserveTasks)state.tasks = state.tasks.filter(task=>!task.sourceIds.some(id=>sourceIds.has(id)||id.startsWith("google:")));
  state.plan = state.plan.filter(block=>state.tasks.some(task=>task.id===block.taskId));
  state.resources = []; state.events = []; delete state.daily;
  state.attachments = state.attachments?.filter(attachment=>attachment.origin==="local");
  const attachmentIds = new Set(state.attachments?.map(attachment=>attachment.id));
  for (const conversation of state.conversations??[]) conversation.attachmentIds=conversation.attachmentIds.filter(id=>attachmentIds.has(id));
  for (const agent of state.agents) agent.resourceIds=[];
  if (state.dailyConfig) state.dailyConfig.enabled=false;
  for (const campaign of state.campaigns) if (["scheduled", "running"].includes(campaign.status)) campaign.status = "paused";
  for (const scan of state.scans) if (["queued", "running"].includes(scan.status)) scan.status = "paused";
  for (const workflow of state.workflows) if (workflow.mode === "automatic") workflow.enabled = false;
  state.runs.unshift({ id: `connection-${Date.now()}`, title: "Google connection changed", description: `Google source context was archived privately and removed from active model context. ${preserveTasks?'Canonical tasks and user corrections were preserved for the same verified data account. ':''}Live queues and automatic reads were paused. Rebind sources before resuming.`, status: "pending", createdAt: now, mode: "live", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [] });
}
export function createGoogleDependencies(userId:string):GoogleDependencies {
 const key=(value:string)=>`${userId}:${value}`;
 const dependencies:GoogleDependencies = {
  tokenStore: {
    async load() { return getSecret<GoogleTokens>(key("google:tokens")); },
    async save(tokens) {
      const write=()=>transaction(() => {
        const previous = getSecret<GoogleTokens>(key("google:tokens"));
        if (tokens.connectionId && tokens.connectionId !== previous?.connectionId) {
          const sameAccount=!!tokens.subject&&tokens.subject===previous?.subject&&!!tokens.ownerSubject&&tokens.ownerSubject===previous.ownerSubject;
          const active = readWorkspace(userId);
          if(previous?.subject&&previous.ownerSubject)archiveProviderTasks(active,userId,'google',`${previous.ownerSubject}|${previous.subject}`,new Set(active.resources.map(resource=>resource.id)));
          pauseForNewConnection(active,userId,sameAccount);
          if(tokens.subject&&tokens.ownerSubject)restoreProviderTasks(active,userId,'google',`${tokens.ownerSubject}|${tokens.subject}`);
          saveWorkspace(userId, active);
          const saved = getValue<WorkspaceState>(key("saved:live"));
          if (saved) { pauseForNewConnection(saved,userId,sameAccount); if(tokens.subject&&tokens.ownerSubject)restoreProviderTasks(saved,userId,'google',`${tokens.ownerSubject}|${tokens.subject}`);setValue(key("saved:live"), saved); }
        }
        setSecret(key("google:tokens"), tokens);
      });
      const previous=getSecret<GoogleTokens>(key("google:tokens"));
      // Refresh can happen inside a workspace action. Only a new grant needs
      // the outer workspace lock, so an in-flight action cannot restore old context.
      if(tokens.connectionId&&tokens.connectionId!==previous?.connectionId)await withWorkspace(userId,async()=>write());
      else write();
    },
    async clear() { await withWorkspace(userId,async()=>transaction(()=>{
      const active=readWorkspace(userId),previous=getSecret<GoogleTokens>(key('google:tokens'));
      if(previous?.subject&&previous.ownerSubject)archiveProviderTasks(active,userId,'google',`${previous.ownerSubject}|${previous.subject}`,new Set(active.resources.map(resource=>resource.id)));
      pauseForNewConnection(active,userId);saveWorkspace(userId,active);
      const saved=getValue<WorkspaceState>(key("saved:live"));if(saved){pauseForNewConnection(saved,userId);setValue(key("saved:live"),saved);}
      deleteValue(key("google:tokens"));
    })); },
  },
  store: {
    async get<T>(key: string) { return getValue<T>(`${userId}:google:kv:${key}`); },
    async set<T>(key: string, value: T) { setValue(`${userId}:google:kv:${key}`, value); },
    async delete(key) { deleteValue(`${userId}:google:kv:${key}`); },
    async reserveOperation(key, fingerprint) {
      const claim=reserveOperation(`${userId}:google:op:${key}`,fingerprint);
      const record=(claim.record.result as OperationRecord | undefined) || {fingerprint,status:"pending" as const};
      return {created:claim.reserved,record};
    },
    async finishOperation(key, record) { finishOperation(`${userId}:google:op:${key}`,record,record.status==="unknown"?"unknown":"succeeded"); },
  },
  async getPermissions() { return readWorkspace(userId).permissions; },
  extractPdfText,
};
 const config=configFromEnv();
 if(userId.startsWith('user:') && config){
   const callback=new URL(config.redirectUri);callback.pathname='/api/google/signin/callback';
   dependencies.identityVerifier=new GoogleSignIn({config:{...config,redirectUri:callback.href},store:dependencies.store});
   dependencies.getAuthenticatedSubject=async()=>{const identity=getValue<{subject:string}>(`identity:user:${userId}`);if(!identity?.subject)throw new Error('Verified Google session ownership is missing.');return identity.subject;};
 }
 return dependencies;
}
// Legacy owner data stays isolated; never assigned to the first public sign-in.
export const googleDependencies=createGoogleDependencies("owner");
