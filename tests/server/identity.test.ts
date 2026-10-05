import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityRouter, identitySession } from '../../server/identity';
import { closeDatabase } from '../../src/lib/server/storage';
let server:Server,base:string;
const directory=mkdtempSync(join(tmpdir(),'proletariat-identity-test-'));
const tokenFetch=vi.fn(async()=>Response.json({id_token:'synthetic-id-token',access_token:'discarded-identity-access-token'}));
const verify=vi.fn(async()=>({subject:'verified-subject',email:'person@example.com',emailVerified:true}));
const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
beforeAll(async()=>{
  vi.stubEnv('DATA_DIR',directory);vi.stubEnv('GOOGLE_CLIENT_ID','synthetic-client');vi.stubEnv('GOOGLE_CLIENT_SECRET','synthetic-secret');vi.stubEnv('GOOGLE_IDENTITY_REDIRECT_URI','http://127.0.0.1:1234/api/identity/callback');vi.stubEnv('FRONTEND_URL','http://127.0.0.1:5173');
  const app=express();app.use(express.json());app.use('/api/identity',createIdentityRouter({verify,fetch:tokenFetch as typeof fetch}));app.get('/private',(req,res)=>res.status(identitySession(req)?200:401).json({authenticated:!!identitySession(req)}));
  app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));closeDatabase();vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});
async function start(){
  const result=await fetch(base+'/api/identity/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge})}).then(r=>r.json());
  const launch=new URL(result.url);const response=await fetch(base+launch.pathname+launch.search,{redirect:'manual'});
  return {launch,response,provider:new URL(response.headers.get('location')!),cookie:response.headers.get('set-cookie')!.split(';')[0]};
}
it('uses least-privilege identity consent and single-use first-party launch tickets',async()=>{
  const s=await start();expect(s.provider.searchParams.get('scope')).toBe('openid email profile');expect(s.provider.searchParams.has('login_hint')).toBe(false);expect(s.provider.searchParams.get('code_challenge_method')).toBe('S256');
  expect((await fetch(base+s.launch.pathname+s.launch.search,{redirect:'manual'})).status).toBe(400);
  expect(s.response.headers.get('set-cookie')).toContain('HttpOnly');
});
it('rejects forged callbacks before exchanging a token',async()=>{
  const count=tokenFetch.mock.calls.length;const s=await start();
  const response=await fetch(base+'/api/identity/callback?state='+s.provider.searchParams.get('state')+'&code=fake',{redirect:'manual'});
  expect(response.status).toBe(400);expect(tokenFetch.mock.calls.length).toBe(count);
});
it('binds verified identity to the initiating browser and rejects handoff replay',async()=>{
  const s=await start();const callback=await fetch(base+'/api/identity/callback?state='+s.provider.searchParams.get('state')+'&code=synthetic',{headers:{Cookie:s.cookie},redirect:'manual'});
  expect(callback.status).toBe(302);const resultUrl=new URL(callback.headers.get('location')!);const code=new URLSearchParams(resultUrl.hash.slice(1)).get('signin');
  const post=(proof:string)=>fetch(base+'/api/identity/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier:proof})});
  expect((await post('wrong')).status).toBe(400);
  const exchange=await post(verifier);expect(exchange.status).toBe(200);const body=await exchange.json();expect(body.email).toBe('person@example.com');
  expect(JSON.stringify(body)).not.toContain('discarded-identity-access-token');expect((await post(verifier)).status).toBe(400);
  expect((await fetch(base+'/private',{headers:{Authorization:`Bearer ${body.token}`}})).status).toBe(200);
});
it('rejects unverified identity even when the displayed email matches',async()=>{
  verify.mockResolvedValueOnce({subject:'different-subject',email:'person@example.com',emailVerified:false});
  const s=await start();const response=await fetch(base+'/api/identity/callback?state='+s.provider.searchParams.get('state')+'&code=synthetic',{headers:{Cookie:s.cookie},redirect:'manual'});expect(response.status).toBe(400);
});
