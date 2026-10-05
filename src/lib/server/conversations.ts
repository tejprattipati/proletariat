import { randomUUID } from 'node:crypto';
import type { ActionRequest, ActionResult, Conversation, WorkspaceState } from '../types';

export function requireConversation(state: WorkspaceState, id: unknown): Conversation {
  const conversation = state.conversations?.find(item => item.id === id);
  if (!conversation) throw new Error('This conversation does not exist in your workspace.');
  return conversation;
}
export function attachToConversation(state: WorkspaceState, id: unknown, ids: unknown) {
  const conversation = requireConversation(state, id);
  if (!Array.isArray(ids) || ids.length > 12 || !ids.every(value => typeof value === 'string')) throw new Error('Choose up to 12 attachments.');
  for (const attachmentId of ids) {
    const attachment = state.attachments?.find(item => item.id === attachmentId && item.mode === state.settings.mode);
    if (!attachment || attachment.status !== 'ready') throw new Error('An attachment is unavailable in this workspace.');
  }
  const attached = [...new Set([...conversation.attachmentIds, ...ids])];
  if (attached.length > 12) throw new Error('This chat supports 12 attachments. Remove one before attaching more.');
  conversation.attachmentIds = attached;
  conversation.updatedAt = new Date().toISOString();
  return conversation;
}
export function conversationAction(input: WorkspaceState, action: ActionRequest): ActionResult {
  const state = structuredClone(input), p = action.payload ?? {}, now = new Date().toISOString();
  state.conversations ??= [];
  let conversation: Conversation;
  if (action.type === 'conversation.create') {
    if (state.conversations.length >= 100) throw new Error('This prototype supports up to 100 conversations per workspace.');
    conversation = {id:randomUUID(), title:'New chat', scope:'workspace', messages:[], attachmentIds:[], createdAt:now, updatedAt:now};
    state.conversations.unshift(conversation);
  } else conversation = requireConversation(state, p.id);
  if (['conversation.create', 'conversation.update'].includes(action.type)) {
    if (p.title !== undefined) {
      if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 120) throw new Error('Chat titles must be 1–120 characters.');
      conversation.title = p.title.trim();
    }
    if ('agentId' in p) {
      if (p.agentId === null || p.agentId === '' || p.agentId === undefined) { conversation.scope='workspace'; delete conversation.agentId; }
      else {
        if (!state.agents.some(agent => agent.id === p.agentId)) throw new Error('Choose an agent in this workspace.');
        conversation.agentId = String(p.agentId); conversation.scope='agent';
      }
    }
  } else if (action.type === 'conversation.attach') attachToConversation(state, conversation.id, p.attachmentIds);
  else if (action.type === 'conversation.detach') conversation.attachmentIds = conversation.attachmentIds.filter(id => id !== p.attachmentId);
  else throw new Error('Unsupported conversation action.');
  conversation.updatedAt=now;
  return {state, entityId:conversation.id, message:action.type === 'conversation.create' ? 'Chat created.' : 'Chat updated.'};
}
