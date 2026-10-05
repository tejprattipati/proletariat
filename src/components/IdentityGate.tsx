import { useEffect, useState, type ReactNode } from 'react';
import { Command, LockKeyhole, LogOut, RefreshCw } from 'lucide-react';
import { api, API_BASE, setOwnerKey } from '../lib/client';
import { Button } from './ui';
type IdentityStatus={authenticated:boolean;configured:boolean;email?:string};
let callbackExchange:Promise<IdentityStatus>|undefined;
async function identityStatus():Promise<IdentityStatus>{
  const code=new URLSearchParams(location.hash.slice(1)).get('signin');
  if(code){
    callbackExchange??=(async()=>{
      const verifier=sessionStorage.getItem('proletariat-signin-verifier');
      history.replaceState(null,'',location.pathname+location.search+'#daily');
      if(!verifier)throw new Error('Sign-in must finish in the browser tab that started it.');
      sessionStorage.removeItem('proletariat-signin-verifier');
      const result=await api<{token:string;email:string}>('/api/identity/exchange',{method:'POST',body:JSON.stringify({code,verifier})});setOwnerKey(result.token);
      return {authenticated:true,configured:true,email:result.email};
    })();
    return callbackExchange;
  }
  if(callbackExchange)return callbackExchange;
  return api<IdentityStatus>('/api/identity/status');
}
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function IdentityGate({children}:{children:ReactNode}){
  const [status,setStatus]=useState<IdentityStatus>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{let mounted=true;identityStatus().then(value=>{if(mounted)setStatus(value);},error=>{if(mounted)setError(error instanceof Error?error.message:'Sign-in status is unavailable.');});
    const expired=()=>{setOwnerKey('');callbackExchange=undefined;setStatus({authenticated:false,configured:true});setError('Your session expired. Sign in again.');};window.addEventListener('proletariat-session-expired',expired);
    return()=>{mounted=false;window.removeEventListener('proletariat-session-expired',expired);};},[]);
  async function login(){setBusy(true);setError('');try{
    const verifier=base64(crypto.getRandomValues(new Uint8Array(32)));sessionStorage.setItem('proletariat-signin-verifier',verifier);
    const challenge=base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const result=await api<{url:string}>('/api/identity/start',{method:'POST',body:JSON.stringify({challenge})});const url=new URL(result.url);
    if(url.origin!==new URL(API_BASE||location.origin).origin||url.pathname!=='/api/identity/authorize')throw new Error('Unexpected sign-in destination.');
    location.assign(url.href);
  }catch(error){setError(error instanceof Error?error.message:'Could not begin Google sign-in.');}finally{setBusy(false);}}
  async function logout(){setBusy(true);try{await api('/api/identity/logout',{method:'POST',body:'{}'});setOwnerKey('');callbackExchange=undefined;setStatus({authenticated:false,configured:true});}catch(error){setError(error instanceof Error?error.message:'Sign-out failed.');}finally{setBusy(false);}}
  if(status?.authenticated)return <><div className="identity-bar"><span>{status.email}</span><button onClick={()=>void logout()} disabled={busy}><LogOut size={13}/>Sign out</button>{error&&<span role="alert">{error}</span>}</div>{children}</>;
  return <main className="identity-shell"><section className="identity-card"><div className="brand"><span className="brand-mark"><Command size={26}/></span>proletariat<span className="brand-period">.</span></div><LockKeyhole size={32} strokeWidth={1.3}/><div><span className="eyebrow">YOUR PRIVATE WORKSPACE</span><h1>One place for your work.</h1><p>Sign in with Google to open your own tasks, chats, and connected workflows.</p><p>Gmail, Drive, and Calendar access are separate choices. Connect your own ChatGPT plan after signing in.</p></div>{error&&<p className="inline-alert" role="alert">{error}</p>}{status&&!status.configured&&<p className="inline-alert">Google sign-in is awaiting backend setup. Your workspace stays locked until it is configured.</p>}<Button variant="primary" onClick={()=>void login()} loading={busy} disabled={busy||status?.configured===false}>Continue with Google</Button>{!status&&!error&&<p><RefreshCw size={13}/> Checking sign-in…</p>}<p className="muted">No workspace data is available before sign-in.</p></section></main>;
}
