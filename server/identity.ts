import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { deleteValue, getValue, setValue } from '../src/lib/server/storage';

const hash=(value:string)=>createHash('sha256').update(value).digest('base64url');
const random=()=>randomBytes(32).toString('base64url');
const COOKIE='proletariat_identity';
const SESSION='proletariat_session';
const jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:10000});
interface Identity {subject:string;email:string;emailVerified:boolean;}
interface Session {userId:string;subject:string;email:string;expiresAt:number;}
interface Attempt {state:string;nonce:string;verifier:string;browserChallenge:string;cookie:string;expiresAt:number;}
const cookie=(req:Request,name:string)=>(req.get('cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(`${name}=`))?.slice(name.length+1);
function configuration(){
  const clientId=process.env.GOOGLE_IDENTITY_CLIENT_ID??process.env.GOOGLE_CLIENT_ID;
  const secret=process.env.GOOGLE_IDENTITY_CLIENT_SECRET??process.env.GOOGLE_CLIENT_SECRET;
  const callback=process.env.GOOGLE_IDENTITY_REDIRECT_URI;
  const frontend=process.env.FRONTEND_URL;
  if(!clientId||!secret||!callback||!frontend)throw new Error('Google identity login needs backend OAuth configuration. Access remains locked.');
  for(const value of [callback,frontend]){const u=new URL(value);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('Identity redirects require HTTPS or local loopback.');}
  return {clientId,secret,callback,frontend};
}
export function identityConfigured(){try{configuration();return true;}catch{return false;}}
export function createIdentitySession(identity:Identity){
  if(!identity.emailVerified||!identity.email||!identity.subject)throw new Error('A verified Google identity is required.');
  // Google's verified subject, not a client-provided email, owns the workspace.
  const userId=`user:${createHash('sha256').update('https://accounts.google.com|'+identity.subject).digest('hex')}`;
  const token=random(),session:Session={userId,subject:identity.subject,email:identity.email.toLowerCase(),expiresAt:Date.now()+12*60*60*1000};
  setValue(`identity:user:${userId}`,{userId,subject:identity.subject,email:session.email});
  const users=getValue<string[]>('identity:users')??[];if(!users.includes(userId))setValue('identity:users',[...users,userId]);
  setValue(`identity:session:${hash(token)}`,session);return {token,session};
}
export function identitySession(req:Request):Session|undefined{
  const token=req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]??cookie(req,SESSION);
  if(!token)return;
  const session=getValue<Session>(`identity:session:${hash(token)}`);
  if(!session||session.expiresAt<=Date.now()||!/^user:[a-f0-9]{64}$/.test(session.userId))return;
  return session;
}
async function verifyIdToken(idToken:string,clientId:string,nonce:string):Promise<Identity>{
  const {payload}=await jwtVerify(idToken,jwks,{issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,algorithms:['RS256'],requiredClaims:['sub','exp','iat','email','email_verified'],clockTolerance:5});
  if(payload.nonce!==nonce||typeof payload.email!=='string'||!payload.sub)throw new Error('Google identity validation failed.');
  return {subject:payload.sub,email:payload.email,emailVerified:payload.email_verified===true};
}
export function createIdentityRouter(options:{verify?:typeof verifyIdToken;fetch?:typeof fetch}={}){
  const router=Router(),attempts=new Map<string,Attempt>(),tickets=new Map<string,{attempt:Attempt;expiresAt:number}>();
  const handoffs=new Map<string,{identity:Identity;challenge:string;expiresAt:number}>();
  function expire(){const now=Date.now();for(const map of [attempts,tickets,handoffs])for(const [key,value] of map)if(value.expiresAt<now)map.delete(key);}
  router.get('/status',(req,res)=>{const session=identitySession(req);res.json({configured:identityConfigured(),authenticated:!!session,email:session?.email});});
  router.post('/start',(req,res)=>{
    const config=configuration();expire();
    const challenge=req.body?.challenge;
    if(typeof challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw new Error('A browser sign-in challenge is required.');
    if(tickets.size+attempts.size>=100)throw new Error('Too many pending sign-ins. Try again later.');
    const attempt:Attempt={state:random(),nonce:random(),verifier:random(),browserChallenge:challenge,cookie:random(),expiresAt:Date.now()+600000};
    const ticket=random();tickets.set(hash(ticket),{attempt,expiresAt:Date.now()+60000});
    const url=new URL(config.callback);url.pathname='/api/identity/authorize';url.search=new URLSearchParams({ticket}).toString();
    res.json({url:url.href});
  });
  router.get('/authorize',(req,res)=>{
    const config=configuration();expire();const key=hash(String(req.query.ticket??'')),start=tickets.get(key);tickets.delete(key);
    if(!start)throw new Error('Restart sign-in from the app.');
    const attempt=start.attempt;attempts.set(hash(attempt.state),attempt);
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:config.callback,response_type:'code',scope:'openid email profile',state:attempt.state,nonce:attempt.nonce,code_challenge:hash(attempt.verifier),code_challenge_method:'S256',prompt:'select_account'}))url.searchParams.set(key,value);
    res.cookie(COOKIE,attempt.cookie,{httpOnly:true,secure:new URL(config.callback).protocol==='https:',sameSite:'lax',path:'/api/identity/callback',maxAge:600000});res.redirect(url.href);
  });
  router.get('/callback',async(req,res)=>{
    const config=configuration();expire();const key=hash(String(req.query.state??'')),attempt=attempts.get(key);
    if(!attempt||cookie(req,COOKIE)!==attempt.cookie)throw new Error('Invalid Google sign-in state.');
    attempts.delete(key);res.clearCookie(COOKIE,{path:'/api/identity/callback'});
    if(req.query.error)throw new Error('Google sign-in was cancelled.');
    const code=typeof req.query.code==='string'?req.query.code:'';if(!code)throw new Error('Google did not return a sign-in code.');
    const response=await (options.fetch??fetch)('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,client_secret:config.secret,redirect_uri:config.callback,code,code_verifier:attempt.verifier}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Google sign-in exchange failed.');
    const data=await response.json() as {id_token?:string};if(!data.id_token)throw new Error('Google did not return a verified identity.');
    const identity=await (options.verify??verifyIdToken)(data.id_token,config.clientId,attempt.nonce);
    if(!identity.emailVerified||!identity.subject||!identity.email)throw new Error('Google did not verify this identity.');
    // Google identity access tokens are deliberately not retained. Service grants
    // remain a separate action in Connections.
    const handoff=random();handoffs.set(hash(handoff),{identity,challenge:attempt.browserChallenge,expiresAt:Date.now()+60000});
    const frontend=new URL(config.frontend);frontend.hash=new URLSearchParams({signin:handoff}).toString();res.redirect(frontend.href);
  });
  router.post('/exchange',(req,res)=>{
    expire();const code=req.body?.code,verifier=req.body?.verifier;
    if(typeof code!=='string'||typeof verifier!=='string'||verifier.length>200)throw new Error('Invalid sign-in exchange.');
    const key=hash(code),handoff=handoffs.get(key);
    if(!handoff||hash(verifier)!==handoff.challenge)throw new Error('Sign-in belongs to a different browser or expired.');
    handoffs.delete(key);const result=createIdentitySession(handoff.identity);
    res.cookie(SESSION,result.token,{httpOnly:true,secure:new URL(configuration().callback).protocol==='https:',sameSite:new URL(configuration().callback).protocol==='https:'?'none':'lax',path:'/api',maxAge:12*60*60*1000});
    res.json({token:result.token,email:result.session.email});
  });
  router.post('/logout',(req,res)=>{
    const token=req.get('authorization')?.replace(/^Bearer /,'')??cookie(req,SESSION);if(token)deleteValue(`identity:session:${hash(token)}`);
    res.clearCookie(SESSION,{path:'/api'});res.json({authenticated:false});
  });
  return router;
}
