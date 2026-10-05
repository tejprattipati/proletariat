import { AsyncLocalStorage } from 'node:async_hooks';
const context=new AsyncLocalStorage<string>();
export function currentUserId(){const id=context.getStore();if(!id)throw Object.assign(new Error('An authenticated user context is required.'),{status:401});return id;}
export function runAsUser<T>(id:string,work:()=>T):T{if(!/^user:[a-f0-9]{64}$/.test(id))throw new Error('Invalid workspace owner.');return context.run(id,work);}
export function userKey(key:string){return `${currentUserId()}:${key}`;}
