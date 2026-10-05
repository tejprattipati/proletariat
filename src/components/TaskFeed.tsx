import { hasUnknownProviderState, isActiveTask, taskHref } from './taskViews';
import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, Clock3, FileText, Flag, LoaderCircle, MessageSquare, MoreHorizontal, Pin, Sparkles } from 'lucide-react';
import { chat } from '../lib/client';
import { getTaskFeedDetails } from '../lib/domain/feed';
import type { Run, Task, WorkspaceState } from '../lib/types';
import { Avatar, Badge, Button, duration, SafeLink, shortDate, shortTime, type ScreenProps } from './ui';

export function taskEvidence(state: WorkspaceState, task: Task): { receipt?: Run; scope: 'task' | 'source' | 'agent' } {
  return { receipt: getTaskFeedDetails(state, task.id).latestRun, scope: 'task' };
}
export function taskNeedsDecision(state: WorkspaceState, task: Task) {
  return getTaskFeedDetails(state, task.id).needsDecision;
}
export function TaskFeed({ tasks, state, run, busy, editTask, openAgent, onState, onError, onRequestStatus }: ScreenProps & { tasks: Task[]; editTask: (task: Task) => void; openAgent: (id: string) => void; onState: (next: WorkspaceState) => void; onError: (message: string) => void; onRequestStatus?: (pending: boolean) => void }) {
  const replyLock = useRef(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  async function reply(event: FormEvent, task: Task) {
    event.preventDefault();
    const input = inputs[task.id]?.trim();
    if (!task.agentId || !input || sending || replyLock.current || busy) return;
    replyLock.current = true; onRequestStatus?.(true);
    setSending(task.id);
    try {
      const result = await chat(task.agentId, input, task.id);
      onState(result.state);
      const message = result.state.agents.find(a => a.id === task.agentId)?.messages.filter(m => m.role === 'assistant' && m.taskId === task.id).at(-1);
      if (message) setAnswers(current => ({ ...current, [task.id]: message.content }));
      setInputs(current => current[task.id]?.trim() === input ? ({ ...current, [task.id]: '' }) : current);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Your reply could not be sent. It is still in the composer.');
    } finally { replyLock.current = false; onRequestStatus?.(false); setSending(null); }
  }
  return <div className="task-feed">{tasks.map(task => {
    const agent = state.agents.find(a => a.id === task.agentId);
    const { receipt, scope } = taskEvidence(state, task);
    const needsDecision = taskNeedsDecision(state, task);
    const running = task.status === 'in_progress' || agent?.status === 'running';
    const sourceIds = [...new Set([...task.sourceIds, ...(receipt?.sourceIds || [])])];
    const resources = state.resources.filter(r => sourceIds.includes(r.id));
    const changedResources = state.resources.filter(r => receipt?.changedResourceIds?.includes(r.id));
    const changedEvents = state.events.filter(e => receipt?.changedEventIds?.includes(e.id));
    const persistedReply = agent?.messages.filter(message => message.role === 'assistant' && message.taskId === task.id).at(-1)?.content;
    const latestAnswer = answers[task.id] || persistedReply;
    const issue = receipt && scope !== 'agent' && ['failed', 'conflict', 'unknown'].includes(receipt.status);
    const showReply = replyTo === task.id;
    return <article key={task.id} className={`feed-card ${needsDecision ? 'feed-needs-decision' : ''} ${task.status === 'done' ? 'feed-completed' : ''}`}>
      <header className="feed-card-heading"><button className={`task-check ${task.status === 'done' ? 'checked' : ''}`} aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}`} disabled={!!busy || !!sending} onClick={() => void run('task.update', { id: task.id, status: task.status === 'done' ? 'open' : 'done' })}>{task.status === 'done' && <Check size={12} strokeWidth={3} />}</button><a className="feed-task-title" href={taskHref(task.id,'#today')}>{task.pinned && <Pin size={12} />}{task.title}</a><button className="icon-button" aria-label={`Edit ${task.title}`} onClick={() => editTask(task)}><MoreHorizontal size={18} /></button></header>
      <div className="feed-card-meta"><Badge tone={task.status === 'done' ? 'green' : needsDecision ? 'orange' : running ? 'purple' : 'neutral'} dot>{task.status === 'done' ? 'Completed' : needsDecision ? 'Needs you' : running ? 'In progress' : 'Ready'}</Badge><span className={`priority priority-${task.priority.toLowerCase()}`}><Flag size={11} />{task.priority}</span><span><Clock3 size={12} />{duration(task.estimateMinutes)}</span>{task.dueDate && <span className={isActiveTask(task) && task.dueDate < state.today && !hasUnknownProviderState(task) ? 'text-red' : ''}>Due {shortDate(task.dueDate)}{task.dueTime ? ` · ${task.dueTime}` : ''}</span>}{task.plannedDate !== state.today && <span>Planned {shortDate(task.plannedDate)}</span>}</div>
      {needsDecision && task.status !== 'done' && <div className="feed-decision"><span className="eyebrow">WHAT NEEDS YOU</span><p>{task.needsInput || (hasUnknownProviderState(task)?`${task.dueDate?'The deadline is recorded;':'Completion status is unconfirmed;'} confirm completion or submission with the source.`:issue ? receipt.status === 'unknown' ? 'The last related action has an uncertain outcome. Check its receipt before retrying.' : 'Review the related result and decide the next step.' : task.status === 'waiting' ? task.notes && task.notes !== 'Fictional demo task.' ? task.notes : 'This task is waiting. Share the decision or missing context, or update its status when it is ready.' : `${agent?.name || 'Your agent'} has flagged something for your attention. Open the conversation or reply here.`)}</p></div>}
      <div className="feed-result"><div className="feed-result-label"><span className="eyebrow">{scope === 'task' ? 'LATEST RESULT' : scope === 'source' ? 'RELATED SOURCE ACTIVITY' : receipt ? 'AGENT’S LATEST ACTIVITY' : 'LATEST RESULT'}</span>{receipt && <span>{shortTime(receipt.createdAt, state.settings.timezone)}</span>}</div>{latestAnswer ? <p className="feed-inline-answer">{latestAnswer}</p> : receipt ? <><strong>{receipt.title}</strong><p>{receipt.description}</p>{scope === 'agent' && <small>Agent activity is shared context; it does not establish progress on this task.</small>}</> : <p className="feed-no-result">No linked run yet. Start a conversation or run a workflow to build a record of progress.</p>}</div>
      <div className="feed-proof"><button onClick={() => setExpanded(current => ({ ...current, [task.id]: !current[task.id] }))} aria-expanded={!!expanded[task.id]}><FileText size={13} />Proof of work<ChevronDown size={12} className={expanded[task.id] ? 'proof-open' : ''} /></button>{receipt ? <div><Badge tone={receipt.status === 'succeeded' ? 'green' : ['failed','unknown','conflict'].includes(receipt.status) ? 'orange' : 'neutral'}>{receipt.status}</Badge><span>{receipt.modelCalls} model call{receipt.modelCalls === 1 ? '' : 's'}</span><span>{receipt.writes} write{receipt.writes === 1 ? '' : 's'}</span></div> : <span>No receipt yet</span>}</div>
      {expanded[task.id] && <div className="feed-proof-detail">{receipt && <><div className="feed-proof-numbers"><span><strong>{receipt.apiCalls}</strong> API calls</span><span><strong>{receipt.tokens.toLocaleString()}</strong> tokens</span><span><strong>{receipt.cacheHits}</strong> cache hits</span><Badge>{receipt.mode}</Badge></div>{receipt.modelCalls === 0 && <p>This receipt records zero model calls.{receipt.apiCalls === 0 ? ' It also records zero provider API calls.' : ''}</p>}{changedResources.length > 0 && <div className="feed-source-links"><strong>Output documents</strong>{changedResources.map(r => <SafeLink key={r.id} url={r.url}>{r.name}</SafeLink>)}</div>}{changedEvents.length > 0 && <div className="feed-source-links"><strong>Calendar outputs</strong>{changedEvents.map(event => <span key={event.id}>{event.title} · {shortTime(event.start,state.settings.timezone)}</span>)}</div>}</>}{resources.length > 0 && <div className="feed-source-links"><strong>Sources</strong>{resources.map(r => <SafeLink key={r.id} url={r.url}>{r.name}</SafeLink>)}</div>}{!receipt && !resources.length && <p>Linked receipts and source references will appear when recorded by the backend.</p>}{receipt && <a className="text-button" href="#activity">View activity receipts<ArrowRight size={12} /></a>}</div>}
      <footer className="feed-card-footer">{agent ? <button className="feed-agent" onClick={() => openAgent(agent.id)}><Avatar agent={agent} small /><span>{agent.name}</span>{agent.status === 'running' && <LoaderCircle className="spin" size={12} />}</button> : <span className="feed-personal">Your next step</span>}{agent ? <Button variant={needsDecision ? 'primary' : 'ghost'} disabled={!!sending} onClick={() => setReplyTo(showReply ? null : task.id)}><MessageSquare size={14} />{showReply ? 'Close reply' : needsDecision ? 'Reply with a decision' : 'Reply to agent'}</Button> : <Button variant="ghost" onClick={() => editTask(task)}>Assign an agent<ArrowRight size={13} /></Button>}</footer>
      {showReply && agent && <form className="feed-composer" onSubmit={event => void reply(event, task)}><label className="sr-only" htmlFor={`task-reply-${task.id}`}>Reply to {agent.name} about {task.title}</label><div className="composer-box"><textarea id={`task-reply-${task.id}`} rows={2} maxLength={10000} value={inputs[task.id] || ''} onChange={event => setInputs(current => ({ ...current, [task.id]: event.target.value }))} placeholder={needsDecision ? 'Share the decision or context that will unblock this…' : 'Ask a question or give the next instruction…'} /><button className="send-message" type="submit" disabled={!!busy || !!sending || !inputs[task.id]?.trim()} aria-label={`Send reply to ${agent.name}`}>{sending === task.id ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}</button></div><span>{state.settings.mode === 'demo' ? 'Demo · model-free response' : 'Live · configured model and permissions apply'} · Saved in {agent.name}’s conversation</span></form>}
    </article>;
  })}</div>;
}
