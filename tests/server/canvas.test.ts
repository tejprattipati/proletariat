import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoState } from '../../src/lib/domain/fixtures';
import { configureCanvas, runCanvas } from '../../src/lib/server/canvas';
import { canvasStatus, connectCanvas, createCanvasDependencies, disconnectCanvas } from '../../src/lib/server/canvas-persistence';
import { closeDatabase, getSecret, readWorkspace, saveWorkspace, setSecret } from '../../src/lib/server/storage';
import { runAsUser } from '../../src/lib/server/user-context';

const directory=mkdtempSync(join(tmpdir(),'proletariat-canvas-server-'));
const a='user:'+'a'.repeat(64),b='user:'+'b'.repeat(64);
beforeAll(()=>{vi.stubEnv('DATA_DIR',directory);vi.stubEnv('TOKEN_ENCRYPTION_KEY',Buffer.alloc(32,9).toString('base64'));vi.stubEnv('CANVAS_ALLOWED_ORIGINS','https://synthetic.instructure.example');});
afterEach(()=>vi.unstubAllGlobals());
afterAll(()=>{closeDatabase();vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});
it('keeps weekly schedule explicit and validates weekday/time',()=>{
  const state=createDemoState();const configured=configureCanvas(state,{type:'canvas.configure',payload:{weekday:3,time:'10:30'}});expect(configured.state.canvasConfig).toMatchObject({enabled:false,weekday:3,time:'10:30'});
  expect(()=>configureCanvas(state,{type:'canvas.configure',payload:{weekday:0}})).toThrow(/weekday/);expect(()=>configureCanvas(state,{type:'canvas.configure',payload:{time:'26:00'}})).toThrow(/HH:mm/);
});
it('repeated synthetic sweeps retain one canonical record and local completion',async()=>{
  const input=createDemoState();input.tasks=[];const first=await runCanvas(input,{type:'canvas.run'});expect(first.state.tasks).toHaveLength(1);first.state.tasks[0].status='done';
  const repeat=await runCanvas(first.state,{type:'canvas.run'});expect(repeat.state.tasks).toHaveLength(1);expect(repeat.state.tasks[0].status).toBe('done');expect(repeat.state.canvas?.newTaskIds).toEqual([]);expect(repeat.state.runs[0].modelCalls).toBe(0);expect(repeat.state.runs[0].apiCalls).toBe(0);
});
it('connects an independently identified Canvas account without touching Google/ChatGPT or another owner',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'canvas-account-different',name:'Fictional Canvas User'})));
  setSecret(`${a}:google:tokens`,{accessToken:'synthetic-google',subject:'data-subject'});setSecret(`${a}:chatgpt:profiles`,{profiles:[{subject:'different-plan'}]});
  const state=createDemoState();state.canvasConfig={enabled:true,time:'09:00',weekday:1};saveWorkspace(a,state);
  const status=await runAsUser(a,()=>connectCanvas('https://synthetic.instructure.example','synthetic-private-canvas-token'));
  expect(status).toMatchObject({connected:true,accountId:'canvas-account-different'});expect(JSON.stringify(status)).not.toContain('synthetic-private-canvas-token');expect(readWorkspace(a).canvasConfig?.enabled).toBe(false);
  expect((await createCanvasDependencies(b).getCredentials())).toBeUndefined();expect(await runAsUser(b,()=>canvasStatus())).toMatchObject({connected:false});
  expect(getSecret(`${a}:google:tokens`)).toEqual({accessToken:'synthetic-google',subject:'data-subject'});expect(getSecret(`${a}:chatgpt:profiles`)).toEqual({profiles:[{subject:'different-plan'}]});
});
it('disconnects only owned Canvas credentials and clears old provider context',async()=>{
  const state=readWorkspace(a);state.settings.mode='live';state.canvas={id:'old',createdAt:'2026-10-05',updatedAt:'2026-10-05',status:'complete',sources:[{id:'canvas:old-source',provider:'canvas',title:'Old provider content',text:'Private synthetic coursework',readAt:'2026-10-05'}],coverage:[],newTaskIds:[],changedTaskIds:[],summary:'Old'};
  state.tasks=[{...createDemoState().tasks[0],id:'canvas-task',sourceIds:['canvas:old-source']}];saveWorkspace(a,state);
  await runAsUser(b,()=>disconnectCanvas());expect(await createCanvasDependencies(a).getCredentials()).toBeTruthy();
  await runAsUser(a,()=>disconnectCanvas());expect(await createCanvasDependencies(a).getCredentials()).toBeUndefined();expect(readWorkspace(a).canvas).toBeUndefined();expect(readWorkspace(a).tasks).toEqual([]);expect(readWorkspace(a).canvasContextResetAt).toBeTruthy();expect(getSecret(`${a}:google:tokens`)).toBeTruthy();
});
it('restores completed canonical records only after explicit verification of the same Canvas account',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'canvas-account-different',name:'Fictional Canvas User'})));
  await runAsUser(a,()=>connectCanvas('https://synthetic.instructure.example','synthetic-reconnected-token'));
  expect(readWorkspace(a).tasks.some(task=>task.id==='canvas-task')).toBe(true);
  expect(readWorkspace(b).tasks.some(task=>task.id==='canvas-task')).toBe(false);
});
