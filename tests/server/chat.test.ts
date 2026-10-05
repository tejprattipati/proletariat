import { afterEach, expect, it, vi } from "vitest";
import { createDemoState } from "../../src/lib/domain/fixtures";
import { applyAction } from "../../src/lib/domain/actions";
import { respondToChat } from "../../src/lib/server/chat";
const execute = async (state: Parameters<typeof applyAction>[0], action: Parameters<typeof applyAction>[1]) => applyAction(state, action);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function modelEnv() {
  vi.stubEnv("MODEL_PROVIDER", "api"); vi.stubEnv("ALLOW_PAID_API", "true");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-model-key"); vi.stubEnv("OPENAI_MODEL", "synthetic-test-model");
  vi.stubEnv("MODEL_INPUT_USD_PER_MILLION", "1"); vi.stubEnv("MODEL_OUTPUT_USD_PER_MILLION", "1");
  vi.stubEnv("MAX_DAILY_MODEL_TOKENS", "1000000");
}
it("links an inline reply, decision and receipt to the exact task", async () => {
  const state=createDemoState(); const task=state.tasks[0]; task.needsInput="Which outline should I use?";
  const result=await respondToChat(state,state.agents[0].id,"Use the shorter outline.",execute,false,undefined,task.id);
  expect(result.state.tasks[0].needsInput).toBeUndefined();
  expect(result.state.tasks[0].notes).toContain("Use the shorter outline.");
  expect(result.state.agents[0].messages.slice(-2).every(message=>message.taskId===task.id)).toBe(true);
  expect(result.state.runs[0].taskId).toBe(task.id);
  expect(result.state.runs[0].modelCalls).toBe(0);
});
it("records actual model usage and persists the pre-request budget hold", async () => {
  modelEnv(); const state=createDemoState(); state.usage.dailyBudgetUsd=100;
  const fetchMock=vi.fn(async()=>Response.json({output:[{type:"message",content:[{type:"output_text",text:"A synthetic reply."}]}],usage:{input_tokens:100,output_tokens:20}}));
  vi.stubGlobal("fetch",fetchMock); const checkpoints:number[]=[];
  const result=await respondToChat(state,state.agents[0].id,"What is next?",execute,true,partial=>checkpoints.push(partial.state.usage.estimatedCostUsd));
  expect(fetchMock).toHaveBeenCalledOnce(); expect(checkpoints[0]).toBeGreaterThan(checkpoints[1]);
  expect(result.state.usage.modelCalls-state.usage.modelCalls).toBe(1);
  expect(result.state.usage.inputTokens-state.usage.inputTokens).toBe(100);
  expect(result.state.usage.estimatedCostUsd-state.usage.estimatedCostUsd).toBeCloseTo(.00012);
});
it("keeps completed tool effects and usage when the next model request fails", async () => {
  modelEnv(); const state=createDemoState(); state.usage.dailyBudgetUsd=100;
  const fetchMock=vi.fn().mockResolvedValueOnce(Response.json({output:[{type:"function_call",call_id:"synthetic-call",name:"perform_action",arguments:JSON.stringify({type:"task.create",payload_json:JSON.stringify({title:"Synthetic retained task"})})}],usage:{input_tokens:100,output_tokens:20}})).mockRejectedValueOnce(new Error("Synthetic provider timeout"));
  vi.stubGlobal("fetch",fetchMock);
  const result=await respondToChat(state,state.agents[0].id,"Please create the requested synthetic task",execute,true);
  expect(result.state.tasks.some(task=>task.title==="Synthetic retained task")).toBe(true);
  expect(result.state.runs[0].status).toBe("failed");
  expect(result.state.usage.modelCalls-state.usage.modelCalls).toBe(2);
  expect(result.message).toContain("budget reservation");
});
it("never calls the model after a zero budget and keeps direct commands available", async () => {
  modelEnv(); const state=createDemoState();state.usage.dailyBudgetUsd=0;const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  const result=await respondToChat(state,state.agents[0].id,"Summarize",execute,true);
  expect(fetchMock).not.toHaveBeenCalled();expect(result.message).toContain("budget");
  const coded=await respondToChat(result.state,state.agents[0].id,"add task: A coded command",execute,true);
  expect(coded.state.tasks.some(task=>task.title==="A coded command")).toBe(true);
});

it("answers connection questions directly without claiming Gmail or model access", async () => {
  modelEnv(); const state=createDemoState(); const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  const result=await respondToChat(state,state.agents[0].id,"Are you connected to my email?",execute,false);
  expect(result.message).toContain("Google is not connected");
  expect(result.message).toContain("No AI model is connected");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("clearly explains unsupported general chat while preserving the message", async () => {
  const state=createDemoState();
  const result=await respondToChat(state,state.agents[0].id,"Write a beautiful essay",execute,false);
  expect(result.message).toContain("cannot interpret general requests yet");
  expect(result.message).toContain("Supported commands");
  expect(result.state.agents[0].messages.at(-2)?.content).toBe("Write a beautiful essay");
  expect(result.state.runs[0].modelCalls).toBe(0);
});
