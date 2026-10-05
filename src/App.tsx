import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, Command, FolderOpen, Home, History, ListTodo, GraduationCap, LoaderCircle, Menu, MessageSquare, Plug, RefreshCw, Sun, X } from 'lucide-react';
import { act, API_BASE, getWorkspace } from './lib/client';
import type { WorkspaceState } from './lib/types';
import { Badge, Button, money, type ActionFn } from './components/ui';
import { ThemeSelector } from './components/ThemeSelector';
import { Daily } from './components/Daily';
import { Conversations } from './components/Conversations';
import { Today } from './components/Today';
import { Agents } from './components/Agents';
import { Resources } from './components/Resources';
import { Activity } from './components/Activity';
import { Connections } from './components/Connections';
import { HomeIndex, TaskViews, TaskDetail, EventDetail } from './components/TaskWorkspace';
const Canvas=lazy(()=>import('./components/Canvas').then(module=>({default:module.Canvas})));
import { parseWorkspaceRoute, taskViewHref } from './components/taskViews';
import { IdentityGate } from './components/IdentityGate';

type Page = 'home'|'daily'|'tasks'|'history'|'task'|'event'|'canvas'|'chats'|'today'|'agents'|'resources'|'activity'|'connections';
const navigation = [{id:'home',name:'Home',icon:Home},{ id: 'daily', name: 'Daily', icon: Sun },{id:'tasks',name:'Tasks',icon:ListTodo},{id:'history',name:'History',icon:History}, { id: 'chats', name: 'Chats', icon: MessageSquare }, { id: 'today', name: 'Plan & feed', icon: Sun }, { id: 'agents', name: 'Agents', icon: Bot }, { id: 'resources', name: 'Resources', icon: FolderOpen },{id:'canvas',name:'Canvas',icon:GraduationCap}, { id: 'activity', name: 'Activity', icon: ActivityIcon }, { id: 'connections', name: 'Connections', icon: Plug }] as const;
export default function App(){return <IdentityGate><WorkspaceApp /></IdentityGate>;}
function WorkspaceApp() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [route,setRoute] = useState(()=>parseWorkspaceRoute(location.hash));
  const page=route.page as Page;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const directBusyRef = useRef(false);
  const [directBusy, setDirectBusy] = useState(false);
  const requestStatus = useCallback((pending: boolean) => { directBusyRef.current = pending; revision.current++; setDirectBusy(pending); }, []);
  const stateRef = useRef<WorkspaceState | null>(null);
  const acceptState=useCallback((next:WorkspaceState)=>{if(!stateRef.current||next.version>=stateRef.current.version){stateRef.current=next;setState(next);}},[]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  const [conversationId,setConversationId] = useState<string>();
  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    const currentRevision = revision.current;
    try { const data = await getWorkspace(); if (!data || !Array.isArray(data.tasks) || !data.settings) throw new Error('The workspace endpoint returned an invalid response. Check your backend connection.'); if (currentRevision === revision.current) { acceptState(data); setError(null); } }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your workspace.'); }
    finally { setLoading(false); }
  }, [acceptState]);
  useEffect(() => { void refresh(true); const handle = () => {setRoute(parseWorkspaceRoute(location.hash));setMobileMenu(false);}; window.addEventListener('hashchange', handle); return () => window.removeEventListener('hashchange', handle); }, [refresh]);
  useEffect(() => { if (!state) return; const reconcile=()=>{if (!busyRef.current && !directBusyRef.current && document.visibilityState === 'visible') void refresh();};const timer=window.setInterval(reconcile,30000);window.addEventListener('focus',reconcile);document.addEventListener('visibilitychange',reconcile);return()=>{clearInterval(timer);window.removeEventListener('focus',reconcile);document.removeEventListener('visibilitychange',reconcile);}; }, [!!state, refresh]);
  useEffect(() => { if (!notice || notice.type === 'error') return; const timer = window.setTimeout(() => setNotice(null), 5500); return () => clearTimeout(timer); }, [notice]);
  const run: ActionFn = useCallback(async (type, payload) => {
    if (busyRef.current || directBusyRef.current) return null;
    busyRef.current = true; revision.current++; setBusy(type); setNotice(null);
    const priorRunIds = new Set(stateRef.current?.runs.map(receipt => receipt.id) || []);
    try { const guardedPayload=type.startsWith('task.')?{expectedVersion:stateRef.current?.version,...payload}:payload; const result = await act({ type, payload:guardedPayload }); acceptState(result.state); setError(null); const receipt = result.state.runs.find(item => !priorRunIds.has(item.id)); const noticeType = receipt && ['failed', 'unknown', 'conflict'].includes(receipt.status) ? 'error' : receipt?.status === 'pending' ? 'info' : 'success'; setNotice({ type: noticeType, text: result.message }); return result; }
    catch (e) { const message=e instanceof Error?e.message:'That action could not be completed. Please try again.';setNotice({type:'error',text:message});if(type.startsWith('task.')&&/workspace changed/i.test(message)){try{acceptState(await getWorkspace());}catch{/* Keep the visible conflict until the user can refresh. */}}return null; }
    finally { busyRef.current = false; revision.current++; setBusy(null); }
  }, [acceptState]);
  function navigateHref(href:string) {setRoute(parseWorkspaceRoute(href));location.hash=href;setMobileMenu(false);}
  function navigate(next: Page, selectedAgentId?: string) { if (selectedAgentId) setAgentId(selectedAgentId); navigateHref(`#${next}`); }
  const screenBusy = busy || (directBusy ? 'conversation.request' : null);
  const mode = state?.settings.mode;
  const pendingCount = state?.runs.filter(r => ['pending', 'conflict', 'failed', 'unknown'].includes(r.status)).length || 0;
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#home" onClick={() => navigate('home')}><span className="brand-mark"><Command size={24} strokeWidth={1.5} /></span><span>proletariat<span className="brand-period">.</span></span></a>
      <div className="workspace-label"><span className="workspace-monogram">P</span><div>Personal workspace<small>Your work, working together</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{navigation.map(({ id, name, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'nav-active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={19} strokeWidth={1.7} /><span>{name}</span>{id === 'agents' && !!state?.agents.length && <span className="nav-count">{state.agents.length}</span>}{id === 'activity' && pendingCount > 0 && <i className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-note"><span className="tiny-stars">✳</span><p>A little less busy.<br />A little more done.</p><span>Built for the work that matters.</span></div>
      <div className="sidebar-bottom"><button onClick={() => navigate('connections')} className="sidebar-status"><span className={`status-light ${mode === 'live' ? 'status-live' : ''}`} /><span>{mode === 'live' ? 'Live workspace' : mode === 'demo' ? 'Demo workspace' : 'Connecting workspace'}<small>{mode === 'demo' ? 'Synthetic data · no real sends' : mode === 'live' ? 'Your permissions stay in control' : 'Waiting for backend'}</small></span><ChevronRight size={15} /></button><button className="help-button" onClick={() => navigate('connections')}><CircleHelp size={15} />Workspace settings<ArrowUpRight size={13} /></button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" onClick={() => setMobileMenu(true)} aria-label="Open navigation"><Menu size={22} /></button><a href="#home" className="desktop-only">Home</a><ChevronRight className="desktop-only" size={13} /><strong>{navigation.find(n => n.id === page)?.name || (page==='task'?'Task details':page==='event'?'Event details':'Workspace')}</strong></div><div className="topbar-actions">{state && <><button className="budget-pill" onClick={() => navigate('activity')} aria-label="View usage and receipts"><span className="status-light status-live" />{state.usage.modelCalls} model calls<span className="muted"> · {money(state.usage.estimatedCostUsd)} API estimate</span></button><Badge tone={mode === 'live' ? 'green' : 'orange'} dot>{mode === 'live' ? 'Live' : 'Demo'}</Badge></>}<ThemeSelector value={state?.settings.accentTheme} disabled={!state||!!screenBusy} onSave={async theme=>Boolean(await run("settings.update",{accentTheme:theme}))} /><button className="icon-button" onClick={() => void refresh(!state)} aria-label="Refresh workspace" disabled={loading || !!screenBusy}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div></header>
      <main id="main-content" className={`main-content page-${page}`}>
        {!state ? <div className="connection-state">{loading ? <><LoaderCircle className="spin" size={32} /><h1>Gathering your workspace</h1><p>Your tasks, agents, and resources will be here in a moment.</p><div className="loading-bars"><i /><i /><i /></div></> : <><Plug size={38} strokeWidth={1.2} /><span className="eyebrow">WORKSPACE UNAVAILABLE</span><h1>Let’s get connected.</h1><p>{error}</p><div className="connection-detail">This frontend needs the proletariat backend. {API_BASE ? 'Check that the configured API service is running and allows this site.' : 'For GitHub Pages, set VITE_API_URL to your deployed backend and rebuild. For local development, start the API server.'}</div><Button variant="primary" onClick={() => void refresh(true)}><RefreshCw size={16} />Try again</Button></>}</div> : <>
        {error && <div className="inline-alert" role="alert"><span><strong>Connection interrupted.</strong> {error} Your last loaded workspace is shown.</span><Button variant="ghost" onClick={() => void refresh()}>Retry</Button></div>}
        {page === 'home' && <HomeIndex state={state}/>}
        {['tasks','history'].includes(page)&&<TaskViews state={state} run={run} busy={screenBusy} filters={route.filters} onFilters={next=>navigateHref(taskViewHref(next))}/>}
        {page==='task'&&<TaskDetail key={route.id} state={state} run={run} busy={screenBusy} id={route.id||''} returnTo={route.returnTo} onNavigate={navigateHref} openAgent={id=>navigate('agents',id)} onState={next=>{revision.current++;acceptState(next);}} onError={text=>setNotice({type:'error',text})} onRequestStatus={requestStatus}/>}
        {page==='event'&&<EventDetail state={state} id={route.id||''} returnTo={route.returnTo}/>}
        {page==='canvas'&&<Suspense fallback={<div className="connection-state" role="status"><LoaderCircle className="spin" size={24}/><p>Loading coursework view…</p></div>}><Canvas state={state} run={run} busy={screenBusy} refresh={()=>refresh()}/></Suspense>}
        {page === 'daily' && <Daily state={state} run={run} busy={screenBusy} onRequestStatus={requestStatus} openAgent={id => navigate('agents',id)} onState={next => {revision.current++;acceptState(next);}} onError={text => setNotice({type:'error',text})} />}
        {page === 'chats' && <Conversations state={state} run={run} busy={screenBusy} onRequestStatus={requestStatus} selectedId={conversationId} onSelect={setConversationId} onState={next => {revision.current++;acceptState(next);}} onError={text => setNotice({type:'error',text})} />}
        {page === 'today' && <Today state={state} run={run} busy={screenBusy} onRequestStatus={requestStatus} openAgent={id => navigate('agents', id)} onState={next => { revision.current++; acceptState(next); }} onError={text => setNotice({ type: 'error', text })} />}
        {page === 'agents' && <Agents state={state} run={run} busy={screenBusy} onRequestStatus={requestStatus} onOpenConversation={id => { setConversationId(id); navigate('chats'); }} selectedId={agentId} onSelect={setAgentId} onState={next => { revision.current++; acceptState(next); }} onError={text => setNotice({ type: 'error', text })} />}
        {page === 'resources' && <Resources state={state} run={run} busy={screenBusy} />}
        {page === 'activity' && <Activity state={state} run={run} busy={screenBusy} />}
        {page === 'connections' && <Connections state={state} run={run} busy={screenBusy} refresh={() => refresh()} />}
        </>}
      </main>
    </div>
    {notice && <div className={`toast toast-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.type === 'success' ? <Check size={18} /> : <CircleHelp size={18} />}<span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
