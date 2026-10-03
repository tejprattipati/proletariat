import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../../server/index";
import { closeDatabase, getSecret, readWorkspace, reserveOperation, saveWorkspace, setSecret } from "../../src/lib/server/storage";
import { googleDependencies } from "../../src/lib/server/google-persistence";
import type { WorkspaceState } from "../../src/lib/types";

let server: Server;
let base: string;
const directory = mkdtempSync(join(tmpdir(), "proletariat-api-test-"));
const owner = { Authorization: "Bearer synthetic-owner-access", "Content-Type": "application/json" };
const visitor = { "X-Workspace-ID": randomUUID(), "Content-Type": "application/json" };
const visitorTwo = { "X-Workspace-ID": randomUUID(), "Content-Type": "application/json" };
async function action(type: string, payload: object, headers: Record<string, string> = owner, requestId = randomUUID()) {
  return fetch(`${base}/api/action`, { method: "POST", headers, body: JSON.stringify({ type, payload, requestId }) });
}
beforeAll(async () => {
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ACCESS_TOKEN", "synthetic-owner-access"); vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("GOOGLE_CLIENT_ID", ""); vi.stubEnv("GOOGLE_CLIENT_SECRET", ""); vi.stubEnv("GOOGLE_REDIRECT_URI", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
it("serves health while refusing anonymous access to workspace and Google routes", async () => {
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  expect((await fetch(`${base}/api/workspace`)).ok).toBe(false);
  expect((await fetch(`${base}/api/google/status`)).status).toBe(401);
});
it("keeps owner and two public demo datasets separate", async () => {
  expect((await action("task.create", { title: "Owner-specific synthetic task" })).ok).toBe(true);
  const first = await fetch(`${base}/api/workspace`, { headers: visitor }).then(r => r.json()) as WorkspaceState;
  expect(first.tasks.some(t => t.title === "Owner-specific synthetic task")).toBe(false);
  const response = await action("task.create", { title: "Visitor-specific synthetic task" }, visitor);
  expect(response.ok).toBe(true);
  const second = await fetch(`${base}/api/workspace`, { headers: visitorTwo }).then(r => r.json()) as WorkspaceState;
  expect(second.tasks.some(t => t.title === "Visitor-specific synthetic task")).toBe(false);
});
it("rejects live mode for public visitors and invalid modes for everyone", async () => {
  expect((await action("settings.update", { mode: "live" }, visitor)).ok).toBe(false);
  expect((await action("settings.update", { mode: "unexpected" })).ok).toBe(false);
  expect(readWorkspace("owner").settings.mode).toBe("demo");
});
it("rejects unapproved browser origins, including bearer-authenticated requests", async () => {
  const response = await fetch(`${base}/api/workspace`, { headers: { ...owner, Origin: "https://untrusted.example.com" } });
  expect(response.status).toBe(403);
});
it("persists request deduplication across database reopen", async () => {
  const requestId = randomUUID();
  expect((await action("task.create", { title: "Exactly once synthetic task" }, owner, requestId)).ok).toBe(true);
  closeDatabase();
  expect((await action("task.create", { title: "Exactly once synthetic task" }, owner, requestId)).ok).toBe(true);
  expect(readWorkspace("owner").tasks.filter(t => t.title === "Exactly once synthetic task")).toHaveLength(1);
  expect((await action("task.create", { title: "Changed contents" }, owner, requestId)).ok).toBe(false);
});
it("records failed commands without discarding earlier completed state", async () => {
  const response = await action("task.update", { id: "missing-task", title: "No task" });
  expect(response.ok).toBe(false);
  const state = readWorkspace("owner");
  expect(state.runs[0].status).toBe("failed");
  expect(state.tasks.some(t => t.title === "Exactly once synthetic task")).toBe(true);
});
it("provides a model-free coded chat action with persistent history", async () => {
  const state = readWorkspace("owner");
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: owner, body: JSON.stringify({ agentId: state.agents[0].id, message: "add task: Prepare the synthetic demo" }) });
  expect(response.ok).toBe(true);
  const result = await response.json();
  expect(result.message).toContain("zero model calls");
  expect(result.state.tasks.some((t: {title:string}) => t.title === "Prepare the synthetic demo")).toBe(true);
});
it("encrypts stored tokens and preserves pending operation reservations", () => {
  setSecret("test-secret", { value: "synthetic-private-payload" });
  expect(getSecret<{value:string}>("test-secret")?.value).toBe("synthetic-private-payload");
  expect(readFileSync(join(directory, "proletariat.sqlite-wal")).includes(Buffer.from("synthetic-private-payload"))).toBe(false);
  expect(reserveOperation("test-pending", "fingerprint").reserved).toBe(true);
  closeDatabase();
  expect(reserveOperation("test-pending", "fingerprint").record.status).toBe("started");
  expect(reserveOperation("test-pending", "fingerprint").reserved).toBe(false);
});
it("pauses live queues and automatic workflows when OAuth grants change", async () => {
  const state = readWorkspace("owner"); state.settings.mode = "live";
  state.campaigns = [{ id: "synthetic-campaign", name: "Example", subject: "Example", body: "Example", status: "running", recipients: [], mode: "live", createdAt: new Date().toISOString(), ratePerMinute: 1 }];
  state.scans = [{ id: "synthetic-scan", provider: "gmail", coverage: "all", status: "running", discovered: 1, read: 0, analyzed: 0, skipped: 0, failed: 0, createdAt: new Date().toISOString(), mode: "live" }];
  state.workflows[0].mode = "automatic"; state.workflows[0].enabled = true;
  saveWorkspace("owner", state);
  await googleDependencies.tokenStore.save({ accessToken: "synthetic-test-token", connectionId: "synthetic-new-grant", expiresAt: Date.now()+100000, scopes: [] });
  const updated = readWorkspace("owner");
  expect(updated.campaigns[0].status).toBe("paused"); expect(updated.scans[0].status).toBe("paused"); expect(updated.workflows[0].enabled).toBe(false);
});
