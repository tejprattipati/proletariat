import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { currentUserId, userKey, runAsUser } from './user-context';
import { getSecret, getValue, setSecret, setValue } from './storage';

const ISSUER='https://auth.openai.com';
const RESOURCE='https://api.openai.com/v1';
const TOKEN_URL=`${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE='chatgpt.tokens.use.direct';
const KEY='chatgpt:profiles';
interface Profile { id:string; clientId:string; subject:string; email?:string; accessToken?:string; refreshToken?:string; idToken?:string; expiresAt:number; scopes:string[]; model?:string; verifiedInferenceAt?:string; }
interface Profiles { activeId?:string; profiles:Profile[]; }
interface Pending { state:string; nonce:string; verifier:string; callback:string; clientId?:string; subject?:string; profileId?:string; expiresAt:number; }
type TokenResponse={access_token?:string;refresh_token?:string;id_token?:string;expires_in?:number;scope?:string;token_type?:string};
const jwks=createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`),{timeoutDuration:10000});
interface Runtime {callbackServer?:Server;pending?:Pending;refresh?:Promise<Profile>;generation:number;starting?:boolean;}
const runtimes=new Map<string,Runtime>();
function runtime(){const id=currentUserId();let value=runtimes.get(id);if(!value){value={generation:0};runtimes.set(id,value);}return value;}
const profiles=()=>getSecret<Profiles>(userKey(KEY))??{profiles:[]};
const selected=()=>{const data=profiles();return data.profiles.find(profile=>profile.id===data.activeId);};
const same=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const random=()=>randomBytes(32).toString('base64url');
function save(profile:Profile, activate=false){const data=profiles();data.profiles=data.profiles.filter(item=>item.id!==profile.id);data.profiles.push(profile);if(activate)data.activeId=profile.id;setSecret(userKey(KEY),data);}
function encryptionReady(){return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY??'','base64').length===32;}
export function planConnected(){try{const p=selected();return Boolean(p?.accessToken&&p.scopes.includes(PLAN_SCOPE)&&(p.expiresAt>Date.now()||p.refreshToken));}catch{return false;}}
export function planStatus(){
  const data=encryptionReady()?profiles():{profiles:[]} as Profiles;
  const active=data.profiles.find(profile=>profile.id===data.activeId);
  return {configured:encryptionReady(),connected:planConnected(),activeId:data.activeId,model:active?.model,verifiedInferenceAt:active?.verifiedInferenceAt,
    profiles:data.profiles.map(p=>({id:p.id,label:p.email??`ChatGPT account ${p.id.slice(0,8)}`,connected:!!p.accessToken,planEnabled:p.scopes.includes(PLAN_SCOPE)})),
    label:planConnected()?'ChatGPT plan connected · usage counts toward your plan; no API-key billing':'Connect your ChatGPT plan · no API key required'};
}
async function json(response:Response){if(!response.ok)throw new Error(`ChatGPT returned HTTP ${response.status}. Reconnect or review your plan limits.`);const text=await response.text();if(text.length>1_000_000)throw new Error('ChatGPT response exceeded the metadata limit.');return JSON.parse(text);}
async function exchange(fields:Record<string,string>):Promise<TokenResponse>{return json(await fetch(TOKEN_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),signal:AbortSignal.timeout(15000)}));}
function tokens(result:TokenResponse,previous?:Profile){
  if(typeof result.access_token!=='string'||!result.access_token||result.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(result.expires_in)||result.expires_in!<=0)throw new Error('ChatGPT returned incomplete credentials. Start sign-in again.');
  const scopes=result.scope===undefined?previous?.scopes??[]:result.scope.split(/\s+/);
  return {accessToken:result.access_token,refreshToken:result.refresh_token??previous?.refreshToken,idToken:result.id_token??previous?.idToken,expiresAt:Date.now()+Math.min(result.expires_in!,86400)*1000,scopes};
}
export async function validatePlanIdentity(idToken:string,clientId:string,nonce?:string){
  const {payload}=await jwtVerify(idToken,jwks,{issuer:ISSUER,audience:clientId,requiredClaims:['sub','exp','iat'],clockTolerance:5,algorithms:['RS256']});
  if(!payload.sub||(nonce!==undefined&&payload.nonce!==nonce))throw new Error('ChatGPT identity validation failed.');
  return {subject:payload.sub,email:typeof payload.email==='string'?payload.email:undefined};
}
export async function completePlanSignIn(query:URLSearchParams,attempt:Pending,verify=validatePlanIdentity){
  const expected=runtime().generation;
  if(attempt.expiresAt<Date.now()||!same(query.get('state')??'',attempt.state))throw new Error('Expired or invalid ChatGPT sign-in state.');
  if(query.has('error'))throw new Error('ChatGPT sign-in was declined. No connection was changed.');
  const code=query.get('code'),clientId=query.get('client_id')??attempt.clientId;
  if(!code||!clientId||!/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId)||(attempt.clientId&&attempt.clientId!==clientId))throw new Error('ChatGPT did not return the expected app registration.');
  const result=await exchange({grant_type:'authorization_code',client_id:clientId,code,code_verifier:attempt.verifier,redirect_uri:attempt.callback,resource:RESOURCE});
  if(!result.id_token)throw new Error('ChatGPT did not return a verifiable identity.');
  const identity=await verify(result.id_token,clientId,attempt.nonce);
  if(attempt.subject&&attempt.subject!==identity.subject)throw new Error('The returning ChatGPT account does not match this registration.');
  const credential=tokens(result);
  if(expected!==runtime().generation)throw new Error('ChatGPT connection changed during sign-in. Start again.');
  const prior=profiles().profiles.find(profile=>profile.clientId===clientId&&profile.subject===identity.subject);
  const profile:Profile={...prior,id:prior?.id??randomUUID(),clientId,...identity,...credential};
  save(profile,true);runtime().generation++;
  return {planEnabled:profile.scopes.includes(PLAN_SCOPE)};
}
export async function beginPlanSignIn(profileId?:string){
  const owner=runtime();
  if(owner.starting)throw new Error('A ChatGPT sign-in is already starting.');
  owner.starting=true;
  try{return await startPlanSignIn(profileId);}finally{owner.starting=false;}
}
async function startPlanSignIn(profileId?:string){
  if(!encryptionReady())throw new Error('Configure the backend token encryption key before connecting ChatGPT.');
  if((runtime().pending?.expiresAt??0)>Date.now())throw new Error('A ChatGPT sign-in is already pending. Complete it or wait up to 10 minutes.');
  const previous=profileId?profiles().profiles.find(profile=>profile.id===profileId):undefined;
  if(profileId&&!previous)throw new Error('Choose a saved ChatGPT account.');
  const host=getValue<string>(userKey('chatgpt:host'))??`urn:uuid:${randomUUID()}`;setValue(userKey('chatgpt:host'),host);
  const state=random(),nonce=random(),verifier=random(),ticket=random(),cookie=random();let launched=false;
  const userId=currentUserId(),generation=runtime().generation;
  const server=createServer((req,res)=>{void runAsUser(userId,async()=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    const address=server.address();const port=typeof address==='object'?address?.port:undefined;
    if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${port}`){res.writeHead(400);res.end('Invalid callback request.');return;}
    const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
    if(url.pathname==='/auth/start'&&!launched&&same(url.searchParams.get('ticket')??'',ticket)){
      launched=true;
      const authorize=new URL(`${ISSUER}/api/accounts/authorize`);
      const fields:Record<string,string>={client_id:previous?.clientId??'dynamic_agent_client',ext_agent_host_id:host,response_type:'code',redirect_uri:runtime().pending!.callback,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
      if(previous?.idToken)fields.id_token_hint=previous.idToken;
      if(!previous)fields.agent_name_hint='proletariat';
      for(const [key,value] of Object.entries(fields))authorize.searchParams.set(key,value);
      res.setHeader('Set-Cookie',`proletariat_plan=${cookie}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`);
      res.writeHead(302,{Location:authorize.href});res.end();return;
    }
    if(url.pathname!=='/auth/callback'||!runtime().pending||!launched||!same(url.searchParams.get('state')??'',state)||!(req.headers.cookie??'').split(';').some(value=>value.trim()===`proletariat_plan=${cookie}`)){res.writeHead(400);res.end('Invalid ChatGPT callback.');return;}
    const attempt=runtime().pending!;runtime().pending=undefined;clearTimeout(expiry);
    res.setHeader('Set-Cookie','proletariat_plan=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');
    try{const result=await completePlanSignIn(url.searchParams,attempt);res.end(result.planEnabled?'ChatGPT plan connected. Return to proletariat and refresh Connections. No inference has run yet.':'Identity connected, but plan usage was not granted. Return to Connections to authorize plan usage.');}
    catch{res.writeHead(400);res.end('ChatGPT sign-in did not complete. Return to Connections and try again. No credentials were exposed.');}
    finally{server.close();if(runtime().callbackServer===server)runtime().callbackServer=undefined;}
  });});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  if(runtime().generation!==generation){server.close();throw new Error('ChatGPT connection changed while sign-in was starting.');}
  const port=(server.address() as {port:number}).port;
  runtime().pending={state,nonce,verifier,callback:`http://127.0.0.1:${port}/auth/callback`,clientId:previous?.clientId,subject:previous?.subject,profileId,expiresAt:Date.now()+600000};runtime().callbackServer=server;
  const expiry=setTimeout(()=>{if(runtime().callbackServer===server){runtime().pending=undefined;runtime().callbackServer=undefined;}server.close();},600000);expiry.unref();
  return {url:`http://127.0.0.1:${port}/auth/start?ticket=${ticket}`,message:'Continue on the Mac running the backend. Review and approve ChatGPT plan usage in the browser. No API key or client secret is required.'};
}
async function activeToken():Promise<Profile>{
  const profile=selected();if(!profile?.accessToken||!profile.scopes.includes(PLAN_SCOPE))throw new Error('Connect ChatGPT and allow plan usage in Connections.');
  if(profile.expiresAt>Date.now()+60000)return profile;
  if(!profile.refreshToken)throw new Error('ChatGPT session expired. Reconnect in Connections.');
  if(!runtime().refresh){const expected=runtime().generation;runtime().refresh=(async()=>{
    const result=await exchange({grant_type:'refresh_token',client_id:profile.clientId,refresh_token:profile.refreshToken!,resource:RESOURCE});
    if(expected!==runtime().generation||selected()?.id!==profile.id)throw new Error('The ChatGPT account changed during renewal.');
    const renewed={...profile,...tokens(result,profile)};
    if(result.id_token){const identity=await validatePlanIdentity(result.id_token,profile.clientId);if(identity.subject!==profile.subject)throw new Error('ChatGPT renewal identity changed.');}
    save(renewed);return renewed;
  })().finally(()=>{runtime().refresh=undefined;});}
  const renewed=await runtime().refresh;if(!renewed?.scopes.includes(PLAN_SCOPE))throw new Error('ChatGPT plan permission was removed.');return renewed!;
}
export async function planModels(){const p=await activeToken();const result=await json(await fetch(`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${p.accessToken}`},redirect:'error',signal:AbortSignal.timeout(15000)}));return (Array.isArray(result.models)?result.models:[]).filter((m:{visibility?:string;slug?:string})=>m.visibility==='list'&&typeof m.slug==='string').map((m:{slug:string;display_name?:string})=>({id:m.slug,label:m.display_name??m.slug}));}
export async function choosePlanModel(model:string){const catalog=await planModels();if(!catalog.some((item:{id:string})=>item.id===model))throw new Error('Choose a model from the current ChatGPT catalog.');const p=selected()!;p.model=model;save(p);}
export function selectPlanProfile(id:string){const data=profiles();if(!data.profiles.some(p=>p.id===id))throw new Error('ChatGPT account not found.');data.activeId=id;setSecret(userKey(KEY),data);runtime().generation++;}
export async function disconnectPlan(){
  runtime().generation++;runtime().pending=undefined;runtime().callbackServer?.close();runtime().callbackServer=undefined;const profile=selected();if(!profile)return {message:'No ChatGPT account is connected.'};
  let revoked=!profile.refreshToken;
  try{if(profile.refreshToken){const discovery=await json(await fetch(`${ISSUER}/.well-known/openid-configuration`,{redirect:'error',signal:AbortSignal.timeout(10000)}));const endpoint=new URL(discovery.revocation_endpoint);if(endpoint.origin!==ISSUER)throw new Error('Unexpected revocation endpoint.');const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:profile.refreshToken,token_type_hint:'refresh_token',client_id:profile.clientId}),signal:AbortSignal.timeout(10000)});revoked=response.status===200;}}catch{/* Explicitly report unconfirmed remote revocation. */}
  delete profile.accessToken;delete profile.refreshToken;delete profile.idToken;profile.scopes=[];profile.expiresAt=0;save(profile);
  return {message:revoked?'ChatGPT disconnected.':'Disconnected locally. Remote revocation was not confirmed; disconnect proletariat in ChatGPT Settings → Usage.'};
}
export interface PlanResponse {output:Array<{type:string;call_id?:string;name?:string;namespace?:string;arguments?:string;content?:Array<{type:string;text?:string}>}>;usage?:{input_tokens:number;output_tokens:number};}
export async function readCompletedPlanResponse(response:Response):Promise<PlanResponse>{
  if(!response.ok||!response.body)throw new Error(`ChatGPT plan request failed (${response.status}). No paid API fallback was used.`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;let completed:PlanResponse|undefined;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2_000_000)throw new Error('ChatGPT response exceeded the local streaming limit.');buffer=(buffer+decoder.decode(part.value,{stream:true})).replace(/\r\n/g,'\n');let end:number;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')continue;const event=JSON.parse(data);if(['response.failed','response.incomplete','error'].includes(event.type))throw new Error('ChatGPT did not complete the response. Check plan availability or usage limits; no paid fallback was used.');if(event.type==='response.completed'){if(event.response?.status!=='completed'||!Array.isArray(event.response.output))throw new Error('ChatGPT did not confirm completed inference.');completed=event.response;}}}}
  finally{await reader.cancel().catch(()=>undefined);}
  if(!completed)throw new Error('ChatGPT stream ended before completed inference. No actions from this response were executed.');return completed;
}
export async function planResponse(instructions:string,input:unknown[],tool:unknown):Promise<PlanResponse>{
  const profile=await activeToken(),expected=runtime().generation;
  const model=profile.model??process.env.CHATGPT_MODEL??'gpt-6.1-sol';
  const response=await fetch(`${RESOURCE}/responses`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${profile.accessToken}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model,instructions,input,store:false,stream:true,service_tier:"default",parallel_tool_calls:false,tools:[{type:'namespace',name:'proletariat',description:'Authorized workflow application controls',tools:[tool]}]})});
  const result=await readCompletedPlanResponse(response);
  if(expected!==runtime().generation||selected()?.id!==profile.id)throw new Error('ChatGPT connection changed while answering. No returned actions were executed.');
  profile.verifiedInferenceAt=new Date().toISOString();save(profile);return result;
}
