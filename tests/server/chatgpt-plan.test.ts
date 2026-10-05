import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completePlanSignIn, planConnected, planResponse, planStatus, readCompletedPlanResponse } from '../../src/lib/server/chatgpt-plan';
import { closeDatabase, getSecret } from '../../src/lib/server/storage';
import { runAsUser } from '../../src/lib/server/user-context';
const a='user:'+'a'.repeat(64),b='user:'+'b'.repeat(64);
let directory:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'proletariat-plan-test-'));vi.stubEnv('DATA_DIR',directory);vi.stubEnv('TOKEN_ENCRYPTION_KEY',Buffer.alloc(32,3).toString('base64'));});
afterEach(()=>{closeDatabase();vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});
const pending=()=>({state:'s'.repeat(43),nonce:'synthetic-nonce',verifier:'synthetic-verifier',callback:'http://127.0.0.1:1455/auth/callback',expiresAt:Date.now()+10000});
const query=()=>new URLSearchParams({state:'s'.repeat(43),code:'synthetic-code',client_id:'oaiapp_synthetic'});
const token=(access='synthetic-plan-token',scope='openid chatgpt.tokens.use.direct')=>({access_token:access,id_token:'synthetic-jwt',token_type:'Bearer',expires_in:3600,scope});
const identity=async()=>({subject:'synthetic-chatgpt-subject',email:'example@example.com'});
const completion={type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Synthetic answer'}]}],usage:{input_tokens:24,output_tokens:8}}};
const sse=(events:unknown[])=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
it('keeps new registration credentials only in the initiating Google user namespace',async()=>{
  const fetcher=vi.fn(async()=>Response.json(token()));vi.stubGlobal('fetch',fetcher);
  await runAsUser(a,()=>completePlanSignIn(query(),pending(),identity));
  expect(runAsUser(a,planConnected)).toBe(true);expect(runAsUser(b,planConnected)).toBe(false);expect(runAsUser(b,planStatus).profiles).toEqual([]);
  expect(getSecret(`${b}:chatgpt:profiles`)).toBeUndefined();
  const form=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(String(form[1].body)).toContain('client_id=oaiapp_synthetic');expect(String(form[1].body)).not.toContain('client_secret');
  expect(JSON.stringify(runAsUser(a,planStatus))).not.toContain('synthetic-plan-token');
});
it('rejects invalid state, denied grants and changed returning registrations before token exchange',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(runAsUser(a,()=>completePlanSignIn(new URLSearchParams('state=wrong'),pending(),identity))).rejects.toThrow(/state/);
  const denied=query();denied.set('error','access_denied');await expect(runAsUser(a,()=>completePlanSignIn(denied,pending(),identity))).rejects.toThrow(/declined/);
  await expect(runAsUser(a,()=>completePlanSignIn(query(),{...pending(),clientId:'oaiapp_other'},identity))).rejects.toThrow(/registration/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('identity without plan permission never enables inference',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(token('synthetic-identity-only','openid email'))));
  await runAsUser(a,()=>completePlanSignIn(query(),pending(),identity));
  expect(runAsUser(a,planConnected)).toBe(false);
  await expect(runAsUser(a,()=>planResponse('Test',[],{}))).rejects.toThrow(/allow plan usage/);
});
it('validates returning identity before replacing an existing profile',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(token())));
  await expect(runAsUser(a,()=>completePlanSignIn(query(),{...pending(),subject:'different-subject'},identity))).rejects.toThrow(/does not match/);
  expect(runAsUser(a,planConnected)).toBe(false);
});
it('requires completed inference and rejects failures even after deltas',async()=>{
  await expect(readCompletedPlanResponse(sse([{type:'response.output_text.delta',delta:'partial'}]))).rejects.toThrow(/before completed/);
  await expect(readCompletedPlanResponse(sse([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed'}]))).rejects.toThrow(/did not complete/);
  expect((await readCompletedPlanResponse(sse([completion]))).usage?.input_tokens).toBe(24);
});
it('uses only the selected user plan and supported streaming options, never a global API key',async()=>{
  vi.stubEnv('OPENAI_API_KEY','synthetic-unused-global-api-key');
  const fetcher=vi.fn(async(url:unknown,options?:RequestInit)=>String(url).endsWith('/oauth/token')?Response.json(token()):sse([completion]));vi.stubGlobal('fetch',fetcher);
  await runAsUser(a,()=>completePlanSignIn(query(),pending(),identity));
  await runAsUser(a,()=>planResponse('Synthetic state',[{role:'user',content:'Hello'}],{type:'function',name:'perform_action'}));
  const request=fetcher.mock.calls.at(-1)!;expect(request[0]).toBe('https://api.openai.com/v1/responses');expect(request[1]?.headers).toMatchObject({Authorization:'Bearer synthetic-plan-token'});
  const body=JSON.parse(String(request[1]?.body));expect(body).toMatchObject({store:false,stream:true,service_tier:'default',tools:[{type:'namespace',name:'proletariat'}]});expect(body.max_output_tokens).toBeUndefined();
  expect(runAsUser(a,planStatus).verifiedInferenceAt).toBeTruthy();
  await expect(runAsUser(b,()=>planResponse('No grant',[],{}))).rejects.toThrow(/Connect ChatGPT/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
