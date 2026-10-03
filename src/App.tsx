import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, Command, FolderOpen, LoaderCircle, Menu, Plug, RefreshCw, Sun, X } from 'lucide-react';
import { act, API_BASE, getWorkspace } from './lib/client';
import type { WorkspaceState } from './lib/types';
import { Badge, Button, money, type ActionFn } from './components/ui';
import { Today } from './components/Today';
import { Agents } from './components/Agents';
import { Resources } from './components/Resources';
import { Activity } from './components/Activity';
import { Connections } from './components/Connections';

type Page = 'today' | 'agents' | 'resources' | 'activity' | 'connections';
const navigation = [{ id: 'today', name: 'Today', icon: Sun }, { id: 'agents', name: 'Agents', icon: Bot }, { id: 'resources', name: 'Resources', icon: FolderOpen }, { id: 'activity', name: 'Activity', icon: ActivityIcon }, { id: 'connections', name: 'Connections', icon: Plug }] as const;
const pageFromHash = (): Page => navigation.some(n => n.id === location.hash.slice(1)) ? location.hash.slice(1) as Page : 'today';
export default function App() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const stateRef = useRef<WorkspaceState | null>(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    const currentRevision = revision.current;
    try { const data = await getWorkspace(); if (!data || !Array.isArray(data.tasks) || !data.settings) throw new Error('The workspace endpoint returned an invalid response. Check your backend connection.'); if (currentRevision === revision.current) { setState(data); setError(null); } }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your workspace.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(true); const handle = () => setPage(pageFromHash()); window.addEventListener('hashchange', handle); return () => window.removeEventListener('hashchange', handle); }, [refresh]);
  useEffect(() => { if (!state) return; const timer = window.setInterval(() => { if (!busyRef.current && document.visibilityState === 'visible') void refresh(); }, 30000); return () => clearInterval(timer); }, [!!state, refresh]);
  useEffect(() => { if (!notice || notice.type === 'error') return; const timer = window.setTimeout(() => setNotice(null), 5500); return () => clearTimeout(timer); }, [notice]);
  const run: ActionFn = useCallback(async (type, payload) => {
    if (busyRef.current) return null;
    busyRef.current = true; revision.current++; setBusy(type); setNotice(null);
    const priorRunIds = new Set(stateRef.current?.runs.map(receipt => receipt.id) || []);
    try { const result = await act({ type, payload }); setState(result.state); setError(null); const receipt = result.state.runs.find(item => !priorRunIds.has(item.id)); const noticeType = receipt && ['failed', 'unknown', 'conflict'].includes(receipt.status) ? 'error' : receipt?.status === 'pending' ? 'info' : 'success'; setNotice({ type: noticeType, text: result.message }); return result; }
    catch (e) { setNotice({ type: 'error', text: e instanceof Error ? e.message : 'That action could not be completed. Please try again.' }); return null; }
    finally { busyRef.current = false; revision.current++; setBusy(null); }
  }, []);
  function navigate(next: Page, selectedAgentId?: string) { if (selectedAgentId) setAgentId(selectedAgentId); setPage(next); location.hash = next; setMobileMenu(false); }
  const mode = state?.settings.mode;
  const pendingCount = state?.runs.filter(r => ['pending', 'conflict', 'failed', 'unknown'].includes(r.status)).length || 0;
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#today" onClick={() => navigate('today')}><span className="brand-mark"><Command size={24} strokeWidth={1.5} /></span><span>proletariat<span className="brand-period">.</span></span></a>
      <div className="workspace-label"><span className="workspace-monogram">P</span><div>Personal workspace<small>Your work, working together</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{navigation.map(({ id, name, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'nav-active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={19} strokeWidth={1.7} /><span>{name}</span>{id === 'agents' && !!state?.agents.length && <span className="nav-count">{state.agents.length}</span>}{id === 'activity' && pendingCount > 0 && <i className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-note"><span className="tiny-stars">✳</span><p>A little less busy.<br />A little more done.</p><span>Built for the work that matters.</span></div>
      <div className="sidebar-bottom"><button onClick={() => navigate('connections')} className="sidebar-status"><span className={`status-light ${mode === 'live' ? 'status-live' : ''}`} /><span>{mode === 'live' ? 'Live workspace' : mode === 'demo' ? 'Demo workspace' : 'Connecting workspace'}<small>{mode === 'demo' ? 'Synthetic data · no real sends' : mode === 'live' ? 'Your permissions stay in control' : 'Waiting for backend'}</small></span><ChevronRight size={15} /></button><button className="help-button" onClick={() => navigate('connections')}><CircleHelp size={15} />Workspace settings<ArrowUpRight size={13} /></button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" onClick={() => setMobileMenu(true)} aria-label="Open navigation"><Menu size={22} /></button><span className="desktop-only">Workspace</span><ChevronRight className="desktop-only" size={13} /><strong>{navigation.find(n => n.id === page)?.name}</strong></div><div className="topbar-actions">{state && <><button className="budget-pill" onClick={() => navigate('activity')} aria-label="View usage and budget"><span className="status-light status-live" />{money(state.usage.estimatedCostUsd)}<span className="muted"> / {money(state.usage.dailyBudgetUsd)}</span></button><Badge tone={mode === 'live' ? 'green' : 'orange'} dot>{mode === 'live' ? 'Live' : 'Demo'}</Badge></>}<button className="icon-button" onClick={() => void refresh(!state)} aria-label="Refresh workspace" disabled={loading || !!busy}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div></header>
      <main id="main-content" className={`main-content page-${page}`}>
        {!state ? <div className="connection-state">{loading ? <><LoaderCircle className="spin" size={32} /><h1>Gathering your workspace</h1><p>Your tasks, agents, and resources will be here in a moment.</p><div className="loading-bars"><i /><i /><i /></div></> : <><Plug size={38} strokeWidth={1.2} /><span className="eyebrow">WORKSPACE UNAVAILABLE</span><h1>Let’s get connected.</h1><p>{error}</p><div className="connection-detail">This frontend needs the proletariat backend. {API_BASE ? 'Check that the configured API service is running and allows this site.' : 'For GitHub Pages, set VITE_API_URL to your deployed backend and rebuild. For local development, start the API server.'}</div><Button variant="primary" onClick={() => void refresh(true)}><RefreshCw size={16} />Try again</Button></>}</div> : <>
        {error && <div className="inline-alert" role="alert"><span><strong>Connection interrupted.</strong> {error} Your last loaded workspace is shown.</span><Button variant="ghost" onClick={() => void refresh()}>Retry</Button></div>}
        {page === 'today' && <Today state={state} run={run} busy={busy} openAgent={id => navigate('agents', id)} onState={next => { revision.current++; setState(next); }} onError={text => setNotice({ type: 'error', text })} />}
        {page === 'agents' && <Agents state={state} run={run} busy={busy} selectedId={agentId} onSelect={setAgentId} onState={next => { revision.current++; setState(next); }} onError={text => setNotice({ type: 'error', text })} />}
        {page === 'resources' && <Resources state={state} run={run} busy={busy} />}
        {page === 'activity' && <Activity state={state} run={run} busy={busy} />}
        {page === 'connections' && <Connections state={state} run={run} busy={busy} refresh={() => refresh()} />}
        </>}
      </main>
    </div>
    {notice && <div className={`toast toast-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.type === 'success' ? <Check size={18} /> : <CircleHelp size={18} />}<span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
