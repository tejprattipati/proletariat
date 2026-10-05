import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, FileText, FolderOpen, HardDrive, LoaderCircle, MessageSquare, Paperclip, Pencil, Plus, RefreshCw, Search, Sparkles, Upload, X } from 'lucide-react';
import { sendConversationMessage, uploadAttachment } from '../lib/client';
import type { Attachment, Conversation, Resource, WorkspaceState } from '../lib/types';
import { DriveAttachmentPicker } from './DriveAttachmentPicker';
import { Avatar, Badge, Button, EmptyState, Field, Modal, SafeLink, shortTime, type ScreenProps } from './ui';

interface PendingUpload { key: string; conversationId: string; file: File; status: 'uploading' | 'failed'; error?: string; retryable: boolean; }
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = /\.(pdf|docx|txt|md|csv|json)$/i;
const fileSize = (bytes?: number) => bytes === undefined ? '' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1,Math.round(bytes / 1024))} KB`;

export function Conversations({ state, run, busy, onState, onError, selectedId, onSelect, onRequestStatus, compact = false, primaryOnly = false }: ScreenProps & { onState: (next: WorkspaceState) => void; onError: (message: string) => void; selectedId?: string; onSelect?: (id: string) => void; onRequestStatus?: (pending: boolean) => void; compact?: boolean; primaryOnly?: boolean; }) {
  const [localId, setLocalId] = useState<string | undefined>(selectedId);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Conversation | 'new' | null>(null);
  const [drafts, setDrafts] = useState<Record<string,string>>({});
  const [sending, setSending] = useState(false);
  const [sendingId, setSendingId] = useState<string>();
  const [uploading, setUploading] = useState<PendingUpload[]>([]);
  const [addingDrive, setAddingDrive] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [errors, setErrors] = useState<Record<string,string>>({});
  const [attaching, setAttaching] = useState(false);
  const [preparingUpload, setPreparingUpload] = useState(false);
  const operation = useRef(false);
  const [expandedSources, setExpandedSources] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const conversations = (state.conversations || []).filter(conversation => !primaryOnly || conversation.scope === 'workspace').slice().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = conversations.find(conversation => conversation.id === (selectedId || localId)) || conversations[0];
  const agent = state.agents.find(item => item.id === selected?.agentId);
  const attachments = (state.attachments || []).filter(attachment => selected?.attachmentIds.includes(attachment.id));
  const draftKey = selected?.id || '__new__';
  const input = drafts[draftKey] || '';
  const error = errors[draftKey];
  function setInput(value: string) { setDrafts(current => ({ ...current, [draftKey]: value })); }
  function clearError(key: string) { setErrors(current => { const next = { ...current }; delete next[key]; return next; }); }
  const pendingFiles = uploading.filter(item => item.conversationId === selected?.id);
  const activeOtherUpload = uploading.find(item => item.status === 'uploading' && item.conversationId !== selected?.id);
  const model = state.connections.find(connection => connection.provider === 'model');
  const modelReady = !!model?.connected;
  const visible = conversations.filter(conversation => conversation.title.toLowerCase().includes(search.toLowerCase()));
  const isUploading = uploading.some(file => file.status === 'uploading');
  const disabled = !!busy || sending || attaching || isUploading || preparingUpload;
  useEffect(() => { if (selectedId) setLocalId(selectedId); }, [selectedId]);
  useEffect(() => { setAddMenu(false); setAddingDrive(false); setExpandedSources([]); }, [selected?.id]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [selected?.messages.length, selected?.id]);
  function select(id: string) { setLocalId(id); onSelect?.(id); }
  async function ensureConversation() {
    if (selected) return selected.id;
    const result = await run('conversation.create', { title: compact ? 'Daily reading' : 'New conversation' });
    if (!result?.entityId) return undefined;
    select(result.entityId);
    return result.entityId;
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (disabled || operation.current || !input.trim()) return;
    operation.current = true;
    setSending(true); setSendingId(draftKey);
    const message = input.trim();
    const originalKey = draftKey;
    let targetKey = originalKey;
    clearError(originalKey);
    try {
      const id = await ensureConversation(); if (!id) return;
      targetKey = id; setSendingId(id); onRequestStatus?.(true);
      const result = await sendConversationMessage(id, message, attachments.filter(attachment => attachment.status === 'ready').map(attachment => attachment.id));
      if (!result.state?.conversations?.some(conversation => conversation.id === id)) throw new Error('The backend did not confirm this conversation. Refresh before sending again.');
      onState(result.state);
      setDrafts(current => {
        const next = { ...current };
        if (next[originalKey]?.trim() === message) delete next[originalKey];
        return next;
      });
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Could not confirm your message. Refresh the chat before sending again.';
      if (targetKey !== originalKey) setDrafts(current => ({ ...current, [targetKey]: current[targetKey] || message }));
      setErrors(current => ({ ...current, [targetKey]: text })); onError(text);
    } finally { onRequestStatus?.(false); operation.current = false; setSending(false); setSendingId(undefined); }
  }
  async function saveConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || operation.current) return;
    const form = new FormData(event.currentTarget);
    const result = await run(editing === 'new' ? 'conversation.create' : 'conversation.update', { ...(editing && editing !== 'new' ? { id: editing.id } : {}), title: String(form.get('title') || '').trim(), agentId: form.get('agentId') || null });
    if (result) { if (result.entityId) select(result.entityId); setEditing(null); }
  }
  async function attemptUpload(item: PendingUpload) {
    const update = (changes: Partial<PendingUpload>) => setUploading(current => current.map(upload => upload.key === item.key ? { ...upload, ...changes } : upload));
    const { file, conversationId } = item;
    if (!file.size) { update({ status: 'failed', error: 'This file is empty. Choose a file with readable content.', retryable: false }); return; }
    if (file.size > MAX_UPLOAD_BYTES) { update({ status: 'failed', error: 'This file is larger than 5 MB. Choose a smaller file.', retryable: false }); return; }
    if (!SUPPORTED_EXTENSIONS.test(file.name)) { update({ status: 'failed', error: 'Unsupported file. Choose PDF, DOCX, TXT, Markdown, CSV, or JSON.', retryable: false }); return; }
    update({ status: 'uploading', error: undefined });
    onRequestStatus?.(true);
    try {
      const result = await uploadAttachment(file, conversationId);
      const confirmed = result.entityId && result.state?.attachments?.some(attachment => attachment.id === result.entityId) && result.state.conversations?.some(conversation => conversation.id === conversationId && conversation.attachmentIds.includes(result.entityId!));
      if (!confirmed) throw new Error('The backend did not confirm this attachment. Refresh before retrying.');
      onState(result.state);
      setUploading(current => current.filter(upload => upload.key !== item.key));
    } catch (cause) { update({ status: 'failed', error: cause instanceof Error ? cause.message : 'The upload was interrupted. Your file is available to retry in this chat.', retryable: true }); }
    finally { onRequestStatus?.(false); }
  }
  async function chooseFiles(files: FileList | null) {
    if (!files?.length || disabled || operation.current) return;
    operation.current = true; setPreparingUpload(true);
    const chosen = Array.from(new Set(Array.from(files)));
    try {
      const id = await ensureConversation(); if (!id) return;
      const items = chosen.map(file => ({ key: crypto.randomUUID(), conversationId: id, file, status: 'uploading' as const, retryable: true }));
      setUploading(current => [...current, ...items]);
      for (const item of items) await attemptUpload(item);
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Could not prepare the upload. Choose the file again.'); }
    finally { operation.current = false; setPreparingUpload(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function retryUpload(item: PendingUpload) {
    if (disabled || operation.current) return;
    operation.current = true; setPreparingUpload(true);
    try { await attemptUpload(item); }
    finally { operation.current = false; setPreparingUpload(false); }
  }
  async function attachDrive(resources: Resource[], selectedResourceIds: string[]) {
    if (disabled || operation.current) return;
    operation.current = true; setAttaching(true); clearError(draftKey);
    try {
      const id = await ensureConversation(); if (!id) return;
      const picked = new Set(selectedResourceIds);
      for (const attachment of attachments.filter(item => item.origin === 'drive' && item.resourceId && !picked.has(item.resourceId))) {
        if (!await run('conversation.detach', { id, attachmentId: attachment.id })) return;
      }
      for (const resource of resources.filter(resource => !attachments.some(item => item.resourceId === resource.id))) {
        if (!await run('attachment.attachDrive', { conversationId: id, resourceId: resource.id })) return;
      }
      setAddingDrive(false);
    } finally { operation.current = false; setAttaching(false); }
  }
  const pane = <section className={`conversation-pane ${compact ? 'conversation-compact' : ''}`}>
    <header className="conversation-header"><span className="conversation-symbol">{agent ? <Avatar agent={agent} small /> : <Sparkles size={19} />}</span><div><h2>{selected?.title || (compact ? 'Daily reading' : 'A new conversation')}</h2><span>{selected ? `${agent?.name || 'Workspace assistant'} · ${selected.messages.length} messages` : 'Your workspace context, in one conversation'}</span></div>{selected && <button className="icon-button" disabled={disabled} onClick={() => setEditing(selected)} aria-label="Rename conversation"><Pencil size={15} /></button>}<Button variant="ghost" disabled={disabled} onClick={() => setEditing('new')}><Plus size={14} />{compact ? 'New chat' : 'New'}</Button></header>
    {!primaryOnly && <label className="conversation-agent-select"><span>Responding agent</span><select value={selected?.agentId || ''} disabled={disabled || !selected} onChange={event => { if (selected) void run('conversation.update', { id: selected.id, agentId: event.target.value || null }); }}><option value="">Workspace assistant</option>{state.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>The conversation stays the same when you choose another agent.</small></label>}
    <div className="chat-context-banner"><span className="status-light" /><span>{state.settings.mode === 'demo' ? 'Demo workspace' : 'Live workspace'} · {modelReady ? model?.label || 'Model configured' : 'Model not connected · coded commands only'}</span></div>
    {!modelReady && <div className="conversation-model-note"><Sparkles size={15} /><p>General AI reading waits for model setup. Sources, uploads, your full task list, and Daily reads remain available.</p><a href="#connections" className="text-button">Setup<ArrowRight size={12} /></a></div>}
    {attachments.length > 0 && <details className="conversation-sources" open><summary><Paperclip size={13} />Sources attached to this conversation<Badge>{attachments.length}</Badge></summary><div>{attachments.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment} expanded={expandedSources.includes(attachment.id)} toggle={() => setExpandedSources(current => current.includes(attachment.id) ? current.filter(id => id !== attachment.id) : [...current, attachment.id])} disabled={disabled} remove={() => { if (selected) void run('conversation.detach', { id: selected.id, attachmentId: attachment.id }); }} />)}</div></details>}
    <div className="chat-messages conversation-messages">{selected?.messages.length ? selected.messages.map(message => <article key={message.id} className={`chat-message message-${message.role}`}>{message.role === 'assistant' && <span className="message-assistant-symbol"><Sparkles size={15} /></span>}<div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong><span>{shortTime(message.createdAt,state.settings.timezone)}</span></div><div className="message-content">{message.content}</div>{!!message.entityIds?.length && <div className="message-artifacts">{message.entityIds.map(id => { const resource = state.resources.find(item => item.id === id); const attachment = state.attachments?.find(item => item.id === id); return resource || attachment ? <SafeLink key={id} url={resource?.url || attachment?.url}><FileText size={12} />{resource?.name || attachment?.name}</SafeLink> : null; })}</div>}</div></article>) : <div className="chat-welcome"><span className="welcome-symbol"><MessageSquare size={25} /></span><h2>{compact ? 'Read your day in one place.' : 'Make space for a conversation.'}</h2><p>{compact ? 'Ask about the Daily sources, bring in a file, or turn a clear next step into a task.' : 'Each conversation keeps its own messages and attachments. Choose the agent that fits this work.'}</p><div className="prompt-suggestions">{(modelReady ? ['What needs my attention?', 'Summarize the attached sources', 'Help me plan my next step'] : ['add task: Review my daily notes','plan my day']).map(prompt => <button key={prompt} onClick={() => { setInput(prompt); composerInput.current?.focus(); }}>{prompt}<ArrowRight size={14} /></button>)}</div></div>}{sending && sendingId === draftKey && <div className="chat-thinking"><LoaderCircle className="spin" size={14} />Waiting for the backend response…</div>}<div ref={messagesEnd} /></div>
    <form className="chat-composer conversation-composer" onSubmit={send}>{error && <p className="text-red" role="alert">{error} Your message remains below.</p>}{sending && sendingId && sendingId !== draftKey && <p className="upload-other-chat" role="status">The reply is being saved to its original chat.<button type="button" className="text-button" onClick={() => select(sendingId)}>Return to chat<ArrowRight size={12} /></button></p>}{activeOtherUpload && <p className="upload-other-chat" role="status">An upload continues in its original chat.<button type="button" className="text-button" onClick={() => select(activeOtherUpload.conversationId)}>Return to chat<ArrowRight size={12} /></button></p>}{preparingUpload && !isUploading && <p className="upload-other-chat" role="status"><LoaderCircle className="spin" size={13} />Preparing the file…</p>}{pendingFiles.length > 0 && <div className="pending-uploads">{pendingFiles.map(item => <div className={`pending-upload ${item.status === 'failed' ? 'upload-failed' : ''}`} key={item.key}>{item.status === 'uploading' ? <LoaderCircle size={16} className="spin" /> : <FileText size={16} />}<div><strong>{item.file.name}</strong><span>{item.status === 'uploading' ? `Uploading and extracting · ${fileSize(item.file.size)}` : item.error}</span></div>{item.status === 'failed' && item.retryable && <button type="button" className="text-button" disabled={disabled} onClick={() => void retryUpload(item)}><RefreshCw size={12} />Retry</button>}<button type="button" className="icon-button" disabled={item.status === 'uploading'} aria-label={`Remove ${item.file.name}`} onClick={() => setUploading(current => current.filter(upload => upload.key !== item.key))}><X size={14} /></button></div>)}</div>}
      <div className="composer-box"><textarea ref={composerInput} value={input} onChange={event => setInput(event.target.value)} rows={compact ? 2 : 3} maxLength={12000} placeholder={modelReady ? compact ? 'Ask about your day or add some context…' : 'Message this conversation…' : 'Try: add task: Review my daily notes'} aria-label="Message this conversation" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (input.trim()) void send(event); } }} /><button className="send-message" type="submit" aria-label="Send conversation message" disabled={disabled || !input.trim()}>{sending ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button></div>
      <div className="composer-tools"><div className="add-file-control"><button type="button" className="add-file-button" aria-expanded={addMenu} aria-label="Add file to this conversation" disabled={disabled} onClick={() => setAddMenu(!addMenu)}><Paperclip size={15} />Add file<ChevronDown size={12} /></button>{addMenu && <div className="add-file-menu"><button type="button" onClick={() => { setAddMenu(false); fileInput.current?.click(); }}><Upload size={16} /><span>From this computer<small>PDF, DOCX, TXT, MD, CSV, JSON · up to 5 MB</small></span></button><button type="button" onClick={() => { setAddMenu(false); setAddingDrive(true); }}><HardDrive size={16} /><span>From Google Drive<small>Browse and search in this chat</small></span></button></div>}</div><span>{state.settings.mode === 'demo' ? 'Demo processing · no live tool writes' : 'Private backend storage · current permissions apply'}</span></div><input ref={fileInput} className="sr-only" type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.json" aria-label="Choose local files to attach" onChange={event => void chooseFiles(event.target.files)} /></form>
  </section>;
  return <>{!compact && <div className="page-heading"><div><div className="eyebrow"><MessageSquare size={14} />YOUR CONTEXT, YOUR CONVERSATIONS</div><h1>Talk through the work<span className="heading-dot">.</span></h1><p>Separate chats, shared resources. Bring a file and choose the right agent.</p></div><Button variant="primary" disabled={disabled} onClick={() => setEditing('new')}><Plus size={16} />New conversation</Button></div>}<div className={compact ? 'panel embedded-conversation' : 'panel conversations-workspace'}>{!compact && <aside className="conversation-directory"><div className="agent-directory-head"><span className="eyebrow">CONVERSATIONS</span><Badge>{conversations.length}</Badge></div><label className="search-field"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search conversations" placeholder="Find a chat…" /></label><div className="conversation-list">{visible.map(conversation => <button key={conversation.id} className={selected?.id === conversation.id ? 'conversation-selected' : ''} onClick={() => select(conversation.id)}><MessageSquare size={15} /><div><strong>{conversation.title}</strong><span>{state.agents.find(item => item.id === conversation.agentId)?.name || 'Workspace assistant'}</span><p>{conversation.messages.at(-1)?.content || 'Start with a message or a file'}</p></div>{conversation.attachmentIds.length > 0 && <span className="conversation-file-count"><Paperclip size={10} />{conversation.attachmentIds.length}</span>}</button>)}{!visible.length && <div className="compact-empty">{search ? 'No matching conversations.' : 'Create a conversation, or send your first message here.'}</div>}</div><div className="directory-footer"><FileText size={14} /><span>Files stay with their conversation.</span></div></aside>}{pane}</div>
    {editing && <Modal title={editing === 'new' ? 'A conversation of its own' : 'Conversation details'} subtitle="A title helps you return to the right context." onClose={() => setEditing(null)}><form className="form-stack" onSubmit={saveConversation}><Field label="Conversation title"><input name="title" required maxLength={160} defaultValue={editing === 'new' ? '' : editing.title} placeholder="e.g. Planning the next release" /></Field><Field label="Responding agent"><select name="agentId" defaultValue={editing === 'new' ? '' : editing.agentId || ''} disabled={primaryOnly}><option value="">Workspace assistant</option>{state.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><div className="form-actions"><Button type="button" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={disabled}>{editing === 'new' ? 'Create conversation' : 'Save conversation'}<ArrowRight size={14} /></Button></div></form></Modal>}
    {addingDrive && <DriveAttachmentPicker state={state} run={run} busy={busy || (attaching ? 'attachment.attachDrive' : null)} selectedIds={attachments.filter(item => item.origin === 'drive').flatMap(item => item.resourceId ? [item.resourceId] : [])} onSelect={(resources, selectedResourceIds) => void attachDrive(resources, selectedResourceIds)} onClose={() => { if (!attaching) setAddingDrive(false); }} />}
  </>;
}
function AttachmentCard({ attachment, expanded, toggle, remove, disabled }: { attachment: Attachment; expanded: boolean; toggle: () => void; remove: () => void; disabled: boolean }) {
  return <article className={`chat-attachment attachment-${attachment.status}`}><div className="chat-attachment-heading"><span className="file-symbol">{attachment.origin === 'drive' ? <HardDrive size={16} /> : <FileText size={16} />}</span><div><SafeLink url={attachment.url}>{attachment.name}</SafeLink><span>{attachment.origin === 'drive' ? 'Google Drive' : 'Local upload'}{attachment.byteSize ? ` · ${fileSize(attachment.byteSize)}` : ''}</span></div><Badge tone={attachment.status === 'ready' ? 'green' : 'orange'}>{attachment.status === 'ready' ? 'Ready' : attachment.status}</Badge>{attachment.truncated && <Badge tone="orange">Bounded excerpt</Badge>}<button className="icon-button" type="button" disabled={disabled} onClick={remove} aria-label={`Remove attachment ${attachment.name}`}><X size={14} /></button></div>{attachment.error && <p className="attachment-error" role="alert">{attachment.error}</p>}{attachment.content && <><button className="attachment-excerpt-toggle" type="button" onClick={toggle}>{expanded ? 'Hide' : 'View'} extracted source context<ChevronDown size={11} /></button>{expanded && <pre className="attachment-excerpt">{attachment.content}</pre>}</>}{attachment.status !== 'ready' && <p className="attachment-error">Remove this attachment and add a supported replacement. It will not be included in the message context.</p>}</article>;
}
