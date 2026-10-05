import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, Unplug } from 'lucide-react';
import { api, API_BASE } from '../lib/client';
import { Badge, Button, Field, Modal, shortDate, shortTime } from './ui';

interface PlanProfile { id: string; label: string; connected: boolean; planEnabled: boolean; }
interface PlanStatus { configured: boolean; connected: boolean; activeId?: string; model?: string; verifiedInferenceAt?: string; profiles: PlanProfile[]; label: string; }
interface PlanModel { id: string; label: string; }
function confirmedStatus(value: PlanStatus) {
  if (typeof value?.configured !== 'boolean' || typeof value.connected !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.some(profile => !profile || typeof profile.id !== 'string' || typeof profile.label !== 'string' || typeof profile.connected !== 'boolean' || typeof profile.planEnabled !== 'boolean')) throw new Error('The backend did not confirm ChatGPT account status.');
  return value;
}
export function ChatGPTConnection({ refresh, disabled = false }: { refresh: () => Promise<void>; disabled?: boolean }) {
  const [status, setStatus] = useState<PlanStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [launchUrl, setLaunchUrl] = useState<string>();
  const [models, setModels] = useState<PlanModel[]>([]);
  const [modelChoice, setModelChoice] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  const lock = useRef(false);
  const localBackend = (() => { try { return ['localhost','127.0.0.1'].includes(new URL(API_BASE || window.location.origin).hostname); } catch { return false; } })();
  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { const next = confirmedStatus(await api<PlanStatus>('/api/chatgpt/status')); setStatus(next); setModelChoice(next.model || ''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ChatGPT status is unavailable.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function operation(name: string, action: () => Promise<void>) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(name); setError(undefined); setMessage(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The ChatGPT connection action could not be confirmed.'); }
    finally { lock.current = false; setBusy(null); }
  }
  async function authorize(profileId?: string) {
    if (!localBackend) return;
    await operation('authorize', async () => {
      setLaunchUrl(undefined);
      const result = await api<{url: string; message?: string}>('/api/chatgpt/authorize', { method:'POST', body:JSON.stringify(profileId ? {profileId} : {}) });
      const url = new URL(result.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/auth/start' || !url.searchParams.get('ticket')) throw new Error('The backend returned an unexpected ChatGPT sign-in URL.');
      setLaunchUrl(url.href); setMessage(result.message || 'Continue in your browser, approve your ChatGPT account’s plan access, then refresh status.');
    });
  }
  async function loadModels() {
    await operation('models', async () => {
      const result = await api<{models: PlanModel[]}>('/api/chatgpt/models');
      if (!Array.isArray(result.models) || result.models.some(model => typeof model.id !== 'string' || typeof model.label !== 'string')) throw new Error('The backend did not confirm the available model catalog.');
      setModels(result.models); if (!result.models.length) setMessage('Your account returned no selectable models. Review ChatGPT plan access before continuing.');
    });
  }
  async function saveModel(event: FormEvent) {
    event.preventDefault();
    await operation('model', async () => {
      const next = confirmedStatus(await api<PlanStatus>('/api/chatgpt/model', { method:'POST', body:JSON.stringify({model:modelChoice}) }));
      setStatus(next); setMessage('Model selection saved. The latest completed response is recorded separately.'); await refresh();
    });
  }
  const active = status?.profiles.find(profile => profile.id === status.activeId);
  return <div className="chatgpt-connection">
    <div className="provider-row"><span className="provider-icon model-icon"><Sparkles size={24} strokeWidth={1.5}/></span><div className="provider-details"><h3>Your ChatGPT account<Badge tone={status?.connected ? 'green' : 'neutral'} dot>{loading ? 'Checking' : status?.connected ? 'Plan authorized' : status?.configured ? 'Sign-in required' : status ? 'Setup needed' : 'Status unavailable'}</Badge></h3><p>{status?.label || 'Connect your own ChatGPT account separately from Google sign-in.'}</p></div><Button variant="ghost" disabled={loading || !!busy || disabled} loading={loading} onClick={async () => { await load(); await refresh(); }} aria-label="Refresh ChatGPT account status"><RefreshCw size={14}/></Button></div>
    {loading && !status && <p className="chatgpt-status-note" role="status"><LoaderCircle className="spin" size={13}/>Checking the backend’s saved account status…</p>}
    {!localBackend && <p className="chatgpt-status-note"><ShieldCheck size={14}/><span>This plan connection requires your own local backend. Complete sign-in on the device running it. Hosted multi-user plan access must be verified separately.</span></p>}
    {status && <div className="chatgpt-account-controls">{status.profiles.length > 0 && <Field label="Your saved ChatGPT accounts"><select value={status.activeId || ''} disabled={!!busy || disabled} onChange={event => void operation('profile', async () => { const next = confirmedStatus(await api<PlanStatus>('/api/chatgpt/select',{method:'POST',body:JSON.stringify({id:event.target.value})})); setStatus(next); setModelChoice(next.model || ''); setModels([]); setLaunchUrl(undefined); await refresh(); })}><option value="" disabled>Choose an account</option>{status.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.planEnabled ? '' : ' · plan consent needed'}</option>)}</select></Field>}<div className="button-group"><Button variant="primary" disabled={!localBackend || !status.configured || !!busy || disabled} loading={busy === 'authorize'} onClick={() => void authorize()}><Sparkles size={14}/>{status.profiles.length ? 'Connect another ChatGPT account' : 'Sign in with ChatGPT'}</Button>{active && <Button disabled={!localBackend || !!busy || disabled} onClick={() => void authorize(active.id)}><RefreshCw size={13}/>Reconnect</Button>}{active && <Button variant="ghost" disabled={!!busy || disabled} onClick={() => setDisconnect(true)}><Unplug size={13}/>Disconnect</Button>}</div>{active && <div className="chatgpt-active-account"><span><Check size={13}/>{active.label}</span><Badge tone={active.planEnabled ? 'green' : 'orange'}>{active.planEnabled ? 'Plan consent granted' : 'Plan consent needed'}</Badge></div>}{status.connected && <div className="chatgpt-model-controls"><div className="chatgpt-model-heading"><div><strong>{status.model ? `Selected model: ${status.model}` : 'Choose an available model'}</strong><p>{status.verifiedInferenceAt ? `Latest completed model response: ${shortDate(status.verifiedInferenceAt)} · ${shortTime(status.verifiedInferenceAt)}` : 'No completed model response has been verified yet.'}</p></div><Button disabled={!!busy || disabled} loading={busy === 'models'} onClick={() => void loadModels()}><RefreshCw size={13}/>Load models</Button></div>{models.length > 0 && <form className="chatgpt-model-form" onSubmit={saveModel}><Field label="Model from your account catalog"><select value={modelChoice} onChange={event => setModelChoice(event.target.value)} disabled={!!busy || disabled}><option value="">Choose a model</option>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></Field><Button type="submit" disabled={!modelChoice || !!busy || disabled} loading={busy === 'model'}>Save model<ArrowRight size={13}/></Button></form>}</div>}</div>}
    {error && <p className="chatgpt-error" role="alert">{error}</p>}{message && <p className="chatgpt-message" role="status">{message}</p>}{launchUrl && <a className="button button-primary chatgpt-continue" href={launchUrl} target="_blank" rel="noopener noreferrer">Continue to ChatGPT<ExternalLink size={14}/></a>}
    {disconnect && <Modal title="Disconnect this ChatGPT account?" subtitle="Your Google session and workspace remain separate." onClose={() => { if (!busy) setDisconnect(false); }}><div className="form-stack"><p className="form-copy">This removes the selected account’s connection from this workspace. The backend will report whether remote revocation was confirmed.</p><div className="form-actions"><Button disabled={!!busy} onClick={() => setDisconnect(false)}>Keep connected</Button><Button variant="danger" disabled={!!busy} loading={busy === 'disconnect'} onClick={() => void operation('disconnect', async () => { const result = await api<{message:string}>('/api/chatgpt/disconnect',{method:'POST',body:'{}'}); setLaunchUrl(undefined); setModels([]); setDisconnect(false); await load(); await refresh(); setMessage(result.message || 'The backend returned no disconnect confirmation. Refresh status.'); })}><Unplug size={13}/>Disconnect</Button></div></div></Modal>}
  </div>;
}
